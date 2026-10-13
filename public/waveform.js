// 波形の描画・範囲選択・拡大縮小（canvas）。ffmpegには依存しない

const LEVEL_FACTOR = 32;         // ピーク階層の縮約率（1段ごとに何倍粗くするか）
const MIN_VIEW_SEC = 0.2;        // 拡大の限界（表示する最短の長さ・秒）
const ZOOM_STEP = 0.8;           // 1操作あたりの表示幅の倍率（小さいほど大きく拡大）
const DRAG_THRESHOLD_PX = 3;     // この距離未満の動きはクリック（選択解除）として扱う
const EDGE_PX = 40;              // ドラッグ中、端からこの距離以内に入ると自動スクロールする
const AUTO_PAN_RATE = 0.02;      // 自動スクロールの速さ（1フレームあたりの表示幅に対する割合。端からの距離で加速する）
const COLOR_ACTIVE = '#5fcdfc';  // 選択範囲内（または未選択時）の波形色
const COLOR_DIM = '#4b5d85';     // 選択範囲外の波形色
const COLOR_SELECTION = 'rgba(95, 205, 252, 0.16)';
const COLOR_PLAYHEAD = '#ffd166'; // 再生位置の線

/**
 * 16bit PCM から、縮約率ずつ粗くした最大振幅の階層を作る（拡大率に応じて使い分けるため）
 * @param {Int16Array} pcm 16bit PCMサンプル
 * @returns {{block: number, data: Uint16Array}[]} 細かい順の階層。block は1要素が表すサンプル数
 */
export function buildPyramid(pcm) {
  const levels = [];
  let block = LEVEL_FACTOR;
  let prev = null; // 1つ前の階層のデータ（null の間はPCMから作る）
  for (;;) {
    const source = prev ?? pcm;
    const step = prev ? LEVEL_FACTOR : block;
    const data = new Uint16Array(Math.ceil(source.length / step));
    for (let i = 0; i < data.length; i++) {
      const from = i * step;
      const to = Math.min(source.length, from + step);
      let max = 0;
      for (let j = from; j < to; j++) {
        const v = prev ? source[j] : Math.abs(source[j]); // -32768 の絶対値も Uint16 に収まる
        if (v > max) max = v;
      }
      data[i] = max;
    }
    levels.push({ block, data });
    if (data.length <= LEVEL_FACTOR * 2) break;
    prev = data;
    block *= LEVEL_FACTOR;
  }
  return levels;
}

/**
 * サンプル範囲 [s0, s1) の最大振幅（絶対値、0〜32768）を、適切な階層から求める
 * @param {Int16Array} pcm 元のPCM
 * @param {{block: number, data: Uint16Array}[]} levels buildPyramid の結果
 * @param {number} s0 開始サンプル（含む）
 * @param {number} s1 終了サンプル（含まない）
 * @returns {number} 最大振幅
 */
export function columnPeak(pcm, levels, s0, s1) {
  const width = s1 - s0;
  // 範囲の幅以下のブロックを持つ最も粗い階層を使う
  let level = -1;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].block <= width) level = i;
  }
  let max = 0;
  if (level < 0) {
    for (let i = s0; i < s1 && i < pcm.length; i++) {
      const v = Math.abs(pcm[i]);
      if (v > max) max = v;
    }
  } else {
    const { block, data } = levels[level];
    const i0 = Math.floor(s0 / block);
    const i1 = Math.max(i0 + 1, Math.ceil(s1 / block));
    for (let i = i0; i < i1 && i < data.length; i++) if (data[i] > max) max = data[i];
  }
  return max;
}

/**
 * 波形表示・範囲選択・拡大縮小を行うコントローラを作る
 * @param {HTMLCanvasElement} canvas 描画先
 * @param {(start: number|null, end: number|null) => void} onSelect ユーザー操作で選択範囲が変わったときの通知（解除は null, null）
 * @param {() => void} onView 表示範囲（拡大縮小・移動）が変わったときの通知
 * @param {(time: number) => void} [onSeek] 波形がクリックされたとき（ドラッグなし）の、クリック位置（秒）の通知
 */
export function createWaveform(canvas, onSelect, onView, onSeek = () => {}) {
  let pcm = null;        // 16bit PCM
  let levels = null;     // ピーク階層
  let rate = 1;          // PCMのサンプリングレート
  let duration = 0;      // 全体の長さ（秒）
  let scale = 1;         // 表示用の拡大率（小さい音でも見えるよう正規化）
  let viewStart = 0;     // 表示範囲の開始（秒）
  let viewEnd = 0;       // 表示範囲の終了（秒）
  let selStart = null;   // 選択開始（秒）
  let selEnd = null;     // 選択終了（秒）
  let playhead = null;   // 再生位置（秒）。null は非表示
  let enabled = true;    // 範囲選択を受け付けるか
  let dragging = false;
  let moved = false;
  let anchorTime = 0;
  let downX = 0;
  let lastX = 0;         // ドラッグ中の最新のポインタX座標（自動スクロール用）
  let panRaf = 0;        // 自動スクロールの requestAnimationFrame ID（0 は停止中）

  /** 表示範囲を制約内に収めて設定し、再描画と通知を行う */
  function setView(start, end) {
    const minWidth = Math.min(MIN_VIEW_SEC, duration);
    let width = Math.min(duration, Math.max(minWidth, end - start));
    let s = Math.max(0, Math.min(start, duration - width));
    viewStart = s;
    viewEnd = s + width;
    draw();
    onView();
  }

  /** 表示範囲の幅（秒） */
  const viewWidth = () => viewEnd - viewStart;

  /** クライアント座標を、波形上の時間（秒）に変換する */
  function timeAt(clientX) {
    const rect = canvas.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return viewStart + Math.min(1, Math.max(0, ratio)) * viewWidth();
  }

  /** 時間（秒）を canvas 上のX座標（CSSピクセル）に変換する */
  const xAt = (t, cssW) => ((t - viewStart) / viewWidth()) * cssW;

  /**
   * 指定した時間を中心に、表示幅を factor 倍にする
   * @param {number} factor 表示幅の倍率（<1 で拡大、>1 で縮小）
   * @param {number} [center] 固定する時間（秒）。省略時は表示範囲の中央
   */
  function zoomBy(factor, center = (viewStart + viewEnd) / 2) {
    if (!pcm) return;
    const width = viewWidth();
    const newWidth = Math.min(duration, Math.max(Math.min(MIN_VIEW_SEC, duration), width * factor));
    const ratio = width > 0 ? (center - viewStart) / width : 0.5; // 中心点の相対位置を保つ
    setView(center - ratio * newWidth, center - ratio * newWidth + newWidth);
  }

  /** 現在の状態を canvas に描画する */
  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return; // 非表示中は描画しない
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!pcm || !levels || duration <= 0 || viewWidth() <= 0) return;

    const mid = cssH / 2;
    const hasSel = selStart !== null && selEnd !== null;
    const selX0 = hasSel ? Math.max(0, xAt(selStart, cssW)) : 0;
    const selX1 = hasSel ? Math.min(cssW, xAt(selEnd, cssW)) : 0;

    // 中央線
    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.fillRect(0, mid, cssW, 1);

    // 1ピクセル幅ごとに、対応するサンプル範囲の最大値を縦線で描く
    const firstSample = viewStart * rate;
    const perPx = (viewWidth() * rate) / cssW;
    for (let x = 0; x < cssW; x++) {
      const s0 = Math.min(pcm.length - 1, Math.floor(firstSample + x * perPx));
      const s1 = Math.min(pcm.length, Math.max(s0 + 1, Math.floor(firstSample + (x + 1) * perPx)));
      const peak = columnPeak(pcm, levels, s0, s1) / 32768;
      const h = Math.max(1, Math.min(1, peak * scale) * (cssH / 2 - 4));
      ctx.fillStyle = !hasSel || (x >= selX0 && x <= selX1) ? COLOR_ACTIVE : COLOR_DIM;
      ctx.fillRect(x, mid - h, 1, h * 2);
    }

    // 選択範囲の強調（表示範囲外にはみ出す部分は描かない）
    if (hasSel && selX1 > selX0) {
      ctx.fillStyle = COLOR_SELECTION;
      ctx.fillRect(selX0, 0, Math.max(1, selX1 - selX0), cssH);
      ctx.fillStyle = '#ffffff';
      if (xAt(selStart, cssW) >= 0) ctx.fillRect(Math.max(0, selX0 - 1), 0, 2, cssH);
      if (xAt(selEnd, cssW) <= cssW) ctx.fillRect(Math.min(cssW - 2, selX1 - 1), 0, 2, cssH);
    }

    // 再生位置（表示範囲内のときだけ描く）
    if (playhead !== null) {
      const px = xAt(playhead, cssW);
      if (px >= 0 && px <= cssW) {
        ctx.fillStyle = COLOR_PLAYHEAD;
        ctx.fillRect(Math.min(cssW - 2, Math.max(0, px - 1)), 0, 2, cssH);
      }
    }
  }

  /** 最新のポインタ位置から選択範囲を更新して通知する（再描画は呼び出し側が行う） */
  function updateSelectionFromPointer() {
    const t = timeAt(lastX);
    selStart = Math.min(anchorTime, t);
    selEnd = Math.max(anchorTime, t);
    onSelect(selStart, selEnd);
  }

  /** 自動スクロールを停止する */
  function stopAutoPan() {
    if (panRaf) cancelAnimationFrame(panRaf);
    panRaf = 0;
  }

  /**
   * ドラッグ中にポインタが左右の端付近（または外）にあれば、端からの距離に応じた速さで表示範囲を動かす。
   * 端から離れたら停止する。動かした分だけ選択範囲も追従させる
   */
  function autoPanTick() {
    panRaf = 0;
    if (!dragging || !moved) return;
    const rect = canvas.getBoundingClientRect();
    let dist = 0; // 端ゾーンへの食い込み量（左は負、右は正）
    if (lastX < rect.left + EDGE_PX) dist = lastX - (rect.left + EDGE_PX);
    else if (lastX > rect.right - EDGE_PX) dist = lastX - (rect.right - EDGE_PX);
    if (dist === 0) return;

    const speed = Math.max(-3, Math.min(3, dist / EDGE_PX)); // 外に出るほど速く（最大3倍）
    const delta = viewWidth() * AUTO_PAN_RATE * speed;
    const before = viewStart;
    // 先に表示範囲を動かし、その上でポインタ位置の時間を選択へ反映する
    const width = viewWidth();
    const s = Math.max(0, Math.min(viewStart + delta, duration - width));
    viewStart = s;
    viewEnd = s + width;
    updateSelectionFromPointer();
    draw();
    onView();
    if (viewStart !== before) panRaf = requestAnimationFrame(autoPanTick); // 端に達していれば止める
  }

  /** ポインタ押下: ドラッグの起点を記録する */
  canvas.addEventListener('pointerdown', (e) => {
    if (!enabled || !pcm) return;
    dragging = true;
    moved = false;
    downX = e.clientX;
    anchorTime = timeAt(e.clientX);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 取得できなくても操作は継続できる */ }
  });

  /** ポインタ移動: ドラッグ中なら選択範囲を更新して通知する */
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    lastX = e.clientX;
    if (!moved && Math.abs(e.clientX - downX) < DRAG_THRESHOLD_PX) return;
    moved = true;
    updateSelectionFromPointer();
    draw();
    if (!panRaf) panRaf = requestAnimationFrame(autoPanTick); // 端付近なら自動スクロール開始
  });

  /** ポインタ解放: ドラッグしていなければクリックとして選択を解除する */
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    stopAutoPan();
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* 解放済みなら無視 */ }
    if (!moved) {
      // クリック: 選択を解除し、クリック位置を再生位置として通知する
      selStart = selEnd = null;
      playhead = anchorTime;
      draw();
      onSelect(null, null);
      onSeek(anchorTime);
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  /** ホイール: 通常は拡大縮小（カーソル位置を中心に）、Shift・横スクロールは左右移動 */
  canvas.addEventListener('wheel', (e) => {
    if (!pcm) return;
    e.preventDefault(); // ページのスクロールやブラウザのズームを止める
    const rect = canvas.getBoundingClientRect();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const delta = (e.deltaX || e.deltaY) / Math.max(1, rect.width) * viewWidth();
      setView(viewStart + delta, viewEnd + delta);
    } else {
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, timeAt(e.clientX));
    }
  }, { passive: false });

  /** キー操作: + / - で拡大縮小、0 で全体表示、左右キーで移動 */
  canvas.addEventListener('keydown', (e) => {
    if (!pcm) return;
    const pan = viewWidth() * 0.1;
    if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
    else if (e.key === '-') zoomBy(1 / ZOOM_STEP);
    else if (e.key === '0') setView(0, duration);
    else if (e.key === 'ArrowLeft') setView(viewStart - pan, viewEnd - pan);
    else if (e.key === 'ArrowRight') setView(viewStart + pan, viewEnd + pan);
    else return;
    e.preventDefault();
  });

  return {
    /** PCMを設定して波形を表示する（全体表示から開始） */
    setData(newPcm, sampleRate) {
      pcm = newPcm;
      rate = sampleRate;
      duration = pcm.length / rate;
      levels = buildPyramid(pcm);
      const top = levels[levels.length - 1].data;
      let max = 0;
      for (const v of top) if (v > max) max = v;
      scale = 1 / Math.max(max / 32768, 0.05); // 無音に近い場合に過剰に拡大しない
      selStart = selEnd = null;
      playhead = null;
      viewStart = 0;
      viewEnd = duration;
      canvas.parentElement.hidden = false;
      draw();
      onView();
    },
    /** 波形と選択を消して非表示にする（メモリも解放する） */
    clear() {
      pcm = null;
      levels = null;
      duration = viewStart = viewEnd = 0;
      selStart = selEnd = null;
      playhead = null;
      dragging = false;
      stopAutoPan();
      canvas.parentElement.hidden = true;
    },
    /** 選択範囲を外部（入力欄など）から設定する。null で解除 */
    setSelection(start, end) {
      if (!pcm) return;
      if (start === null || end === null) {
        selStart = selEnd = null;
      } else {
        selStart = Math.max(0, Math.min(start, duration));
        selEnd = Math.max(selStart, Math.min(end, duration));
      }
      draw();
    },
    /** 選択範囲が画面いっぱいに見えるよう拡大する（余白あり）。未選択なら何もしない */
    zoomToSelection() {
      if (!pcm || selStart === null || selEnd === null || selEnd <= selStart) return;
      const margin = (selEnd - selStart) * 0.05;
      setView(selStart - margin, selEnd + margin);
    },
    zoomBy,
    /** 全体を表示する */
    zoomFit() { if (pcm) setView(0, duration); },
    /**
     * 再生位置（秒）を設定して再描画する。null で非表示
     * @param {number|null} time 再生位置
     * @param {boolean} [follow] true なら、再生位置が表示範囲外のとき表示範囲を追従させる
     */
    setPlayhead(time, follow = false) {
      if (!pcm) return;
      playhead = time;
      if (follow && time !== null && (time < viewStart || time > viewEnd)) {
        const width = viewWidth();
        const start = time - width * 0.1; // 再生位置が左寄り（10%）に来るよう送る
        setView(start, start + width);   // 描画と onView 通知を含む
        return;
      }
      draw();
    },
    getPlayhead: () => playhead,
    /** 表示幅を保ったまま、表示範囲の開始位置（秒）を移動する */
    panTo(startSec) {
      if (!pcm) return;
      const width = viewWidth();
      setView(startSec, startSec + width);
    },
    /** 操作の受付可否（範囲選択）を切り替える（変換中は無効にする） */
    setEnabled(value) {
      enabled = value;
      canvas.classList.toggle('disabled', !value);
    },
    draw,
    hasData: () => pcm !== null,
    /** 全体の長さ（秒） */
    getDuration: () => duration,
    /** 現在の選択範囲（未選択は [null, null]） */
    getSelection: () => [selStart, selEnd],
    /** 現在の表示範囲と、全体表示かどうか */
    getView: () => ({ start: viewStart, end: viewEnd, full: viewStart <= 0 && viewEnd >= duration }),
  };
}
