// webm → mp3 / mp4 変換アプリ本体（ffmpeg.wasm をブラウザ内で実行する）
import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { createWaveform } from './waveform.js';
import { FORMATS, buildFfmpegArgs } from './ffmpeg-args.js';

const SIZE_WARN_BYTES = 1024 * 1024 * 1024; // これを超えると失敗の可能性が高い旨を警告する（入力はWORKERFSでコピーしないが出力・wasm上限に依存）
const MOUNT_DIR = '/mnt';                    // WORKERFSのマウント先
const INPUT_NAME = 'input.webm';             // マウント時に付ける固定名（元のファイル名に依存しないため）
const INPUT_PATH = `${MOUNT_DIR}/${INPUT_NAME}`;
const OUTPUT_NAMES = Object.values(FORMATS).map((f) => f.output); // 掃除対象の出力ファイル名
const WAVE_NAME = 'wave.pcm';                // 波形用の一時ファイル
const WAVE_RATE = 4000;                      // 波形用PCMのサンプリングレート（Hz）。低くして軽量化する
const NO_AUDIO_MESSAGE = 'このwebmファイルには音声トラックが含まれていないため、mp3に変換できません。\n（画面録画で「音声を共有」をオフにして録画したファイルなどが該当します。映像のみのmp4には変換できます）';
const NO_VIDEO_MESSAGE = 'このwebmファイルには映像トラックが含まれていないため、mp4に変換できません。\n（音声のみの録音ファイルが該当します。mp3には変換できます）';

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), dropText: $('dropText'), fileInput: $('fileInput'),
  bitrate: $('bitrate'), startTime: $('startTime'), endTime: $('endTime'),
  format: $('format'), resolution: $('resolution'), quality: $('quality'),
  bitrateLabel: $('bitrateLabel'), videoNote: $('videoNote'), videoOpts: document.querySelectorAll('.video-opt'),
  convertBtn: $('convertBtn'), cancelBtn: $('cancelBtn'),
  progress: $('progress'), status: $('status'), error: $('error'), result: $('result'),
  wave: $('wave'), waveInfo: $('waveInfo'), waveScroll: $('waveScroll'), waveScrollInner: $('waveScrollInner'),
  zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'), zoomSel: $('zoomSel'),
  playBtn: $('playBtn'),
};

let ffmpeg = null;       // FFmpegインスタンス（中止時は作り直す）
let loaded = false;      // コアの読み込み済みフラグ
let selectedFile = null; // 選択中のファイル
let objectUrl = null;    // ダウンロード用URL（解放管理用）
let cancelled = false;   // ユーザーが変換を中止したか
let ffmpegLog = [];      // 直近のffmpegログ（エラー解析用）
let isMounted = false;   // WORKERFSをマウント中か
let busyKind = null;     // 実行中の処理: null | 'wave'（波形生成）| 'convert'（変換）
let waveJobId = 0;       // 波形生成ジョブの識別子（古いジョブの結果を捨てるため）
let audioMissing = false; // 音声トラックが無いと判明したか
let syncingScroll = false; // プログラムがスクロールバーを動かしている最中か（scroll イベントを無視するため）
let scrollDriven = false;  // 表示範囲の変更がスクロールバー操作によるものか
let audio = null;          // 再生用のAudio要素（選択ファイルを直接再生する）
let audioUrl = null;       // 再生用のオブジェクトURL（解放管理用）
let playRaf = 0;           // 再生位置更新ループの requestAnimationFrame ID（0 は停止中）

/** ステータス文言を更新する */
function setStatus(text) {
  el.status.textContent = text;
}

/** エラーを画面に表示する（null/空で非表示） */
function showError(message) {
  el.error.textContent = message || '';
  el.error.hidden = !message;
}

/** 進捗バーを更新する（null で非表示） */
function setProgress(percent) {
  if (percent === null) {
    el.progress.hidden = true;
    return;
  }
  el.progress.hidden = false;
  el.progress.value = Math.max(0, Math.min(100, percent));
}

/**
 * 実行中の処理に応じてUIの有効/無効を切り替える
 * @param {null|'wave'|'convert'} kind 実行中の処理。null は待機中
 */
function setBusy(kind) {
  busyKind = kind;
  // 音声が無い入力は、mp3 には変換できない（映像のみの mp4 は可能）
  const blockedByNoAudio = audioMissing && el.format.value === 'mp3';
  el.convertBtn.disabled = kind !== null || !selectedFile || blockedByNoAudio;
  el.cancelBtn.hidden = kind === null;
  // 変換中だけ設定の変更を禁止する（波形生成中は時間入力などを先に触れる）
  const locked = kind === 'convert';
  el.format.disabled = el.resolution.disabled = el.quality.disabled = locked;
  el.bitrate.disabled = el.startTime.disabled = el.endTime.disabled = locked;
  waveform.setEnabled(!locked);
}

/** 出力形式の変更に合わせて、映像用の設定・注意書き・ボタン文言・エラー表示を切り替える */
function onFormatChange() {
  const isMp4 = el.format.value === 'mp4';
  el.videoOpts.forEach((node) => { node.hidden = !isMp4; });
  el.videoNote.hidden = !isMp4;
  el.bitrateLabel.textContent = isMp4 ? '🎚️ 音声ビットレート' : '🎚️ ビットレート';
  el.convertBtn.textContent = `✨ ${el.format.value}に変換`;
  el.result.hidden = true; // 別形式の結果リンクが残らないようにする
  if (audioMissing) {
    // 音声が無い入力: mp3 ならエラー、mp4 なら映像のみになる旨を案内する
    showError(isMp4 ? '' : NO_AUDIO_MESSAGE);
    if (isMp4) setStatus('このファイルには音声トラックがないため、映像のみのmp4になります。');
  }
  setBusy(busyKind);
}

/**
 * 秒を "m:ss" / "h:mm:ss"（小数は0.1秒単位）の文字列にする
 * @param {number} sec 秒
 * @returns {string} 時間文字列（parseTime で読み戻せる形式）
 */
function formatTime(sec) {
  const total = Math.round(Math.max(0, sec) * 10) / 10;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const sText = (Number.isInteger(s) ? String(s) : s.toFixed(1)).padStart(Number.isInteger(s) ? 2 : 4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sText}` : `${m}:${sText}`;
}

/**
 * 時間文字列を秒に変換する。受け付ける形式: "90", "1:30", "0:01:30", "1.5"
 * @param {string} text 入力文字列
 * @param {string} label エラーメッセージ用の項目名
 * @returns {number|null} 秒数。空欄の場合は null
 * @throws {Error} 形式が不正な場合
 */
function parseTime(text, label) {
  const value = text.trim();
  if (value === '') return null;
  const parts = value.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new Error(`${label}の形式が正しくありません（例: 90 / 1:30 / 0:01:30）`);
  }
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/**
 * 入力値から ffmpeg の引数を組み立てる
 * @returns {string[]} ffmpeg の引数配列
 * @throws {Error} 時間指定が不正な場合
 */
function buildArgs() {
  return buildFfmpegArgs({
    format: el.format.value,
    inputPath: INPUT_PATH,
    start: parseTime(el.startTime.value, '開始時間'),
    end: parseTime(el.endTime.value, '終了時間'),
    audioBitrate: el.bitrate.value,
    resolution: el.resolution.value,
    quality: el.quality.value,
  });
}

/** 新しいFFmpegインスタンスを作成してイベントを登録する */
function createFFmpeg() {
  const instance = new FFmpeg();
  instance.on('log', ({ message }) => {
    ffmpegLog.push(message);
    if (ffmpegLog.length > 50) ffmpegLog.shift();
  });
  instance.on('progress', ({ progress }) => {
    // 区間指定時などに範囲外の値が来ることがあるため丸める
    if (Number.isFinite(progress)) setProgress(progress * 100);
  });
  return instance;
}

/**
 * ffmpeg コア（js/wasm）をローカルから読み込む。読み込み済みなら何もしない
 * @throws {Error} 読み込みに失敗した場合
 */
async function ensureLoaded() {
  if (loaded) return;
  setStatus('変換エンジンを読み込み中…（初回は数秒かかります）');
  const base = new URL('/vendor/core/', location.href);
  await ffmpeg.load({
    coreURL: new URL('ffmpeg-core.js', base).href,
    wasmURL: new URL('ffmpeg-core.wasm', base).href,
  });
  loaded = true;
}

/**
 * 入力ファイルをコピーせずWORKERFSで直接参照できるようにする（メモリ使用量の削減）
 * @param {File} file マウントするファイル
 * @throws {Error} マウントに失敗した場合
 */
async function mountInput(file) {
  try {
    await ffmpeg.createDir(MOUNT_DIR);
  } catch {
    /* 既に存在する場合は無視 */
  }
  const mounted = await ffmpeg.mount('WORKERFS', { blobs: [{ name: INPUT_NAME, data: file }] }, MOUNT_DIR);
  if (!mounted) throw new Error('入力ファイルのマウントに失敗しました');
  isMounted = true;
}

/**
 * マウント解除と一時ファイルの削除を行う。失敗しても処理は続行する
 * @param {string[]} tempFiles 削除する一時ファイル名
 */
async function cleanupEngine(tempFiles) {
  if (!ffmpeg || !loaded) return;
  if (isMounted) {
    try { await ffmpeg.unmount(MOUNT_DIR); } catch (e) { console.warn('unmount失敗:', e); }
  }
  for (const name of tempFiles) {
    try { await ffmpeg.deleteFile(name); } catch { /* 存在しない場合は無視 */ }
  }
}

/** ffmpegを強制終了して破棄する。次回利用時に再読み込みされる */
function terminateEngine() {
  try {
    ffmpeg?.terminate();
  } catch (e) {
    console.error('ffmpegの終了処理でエラー:', e);
  }
  ffmpeg = null;
  loaded = false;
  isMounted = false;
}

/** 波形の下の説明文を更新する（全体の長さ・選択範囲・拡大中の表示範囲） */
function updateWaveInfo() {
  if (!waveform.hasData()) {
    el.waveInfo.textContent = '';
    el.zoomSel.disabled = true;
    return;
  }
  const [start, end] = waveform.getSelection();
  const view = waveform.getView();
  const parts = [`全体 ${formatTime(waveform.getDuration())}`];
  if (!view.full) parts.push(`表示 ${formatTime(view.start)} – ${formatTime(view.end)}`);
  const playhead = waveform.getPlayhead();
  if (playhead !== null) parts.push(`再生位置 ${formatTime(playhead)}`);
  parts.push(start !== null && end !== null
    ? `選択 ${formatTime(start)} – ${formatTime(end)}（長さ ${formatTime(end - start)}）`
    : '波形をドラッグして範囲を選択（クリックで解除・再生位置の指定）');
  el.waveInfo.textContent = parts.join('　');
}

/**
 * 表示範囲が変わったとき、スクロールバーと説明文を同期する。
 * スクロールバーは「全体の長さ ÷ 表示幅」倍の幅を持つ中身を横スクロールさせる方式のため、
 * つまみの長さが表示中の割合になる（標準のスクロールバーの見た目と動作）
 */
function onWaveView() {
  const view = waveform.getView();
  const total = waveform.getDuration();
  const width = view.end - view.start;
  el.waveScrollInner.style.width = `${width > 0 ? (total / width) * 100 : 100}%`;
  if (!scrollDriven) {
    // スクロールバー自身の操作が原因のときは位置を書き戻さない（ずれ・ちらつき防止）
    syncingScroll = true;
    el.waveScroll.scrollLeft = total > 0 ? (view.start / total) * el.waveScroll.scrollWidth : 0;
    requestAnimationFrame(() => { syncingScroll = false; }); // scroll イベント発火後に解除する
  }
  el.zoomSel.disabled = waveform.getSelection()[0] === null;
  updatePlayUi();
  updateWaveInfo();
}

/** 再生ボタンの表示（再生中は一時停止表示）と有効/無効を更新する */
function updatePlayUi() {
  const playing = audio !== null && !audio.paused;
  el.playBtn.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
  el.playBtn.disabled = audio === null || !waveform.hasData();
}

/** 再生用のAudio要素を破棄する（再生停止・ループ停止・URL解放） */
function unloadAudio() {
  if (playRaf) cancelAnimationFrame(playRaf);
  playRaf = 0;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // 読み込み中のデータを解放する
    audio = null;
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  updatePlayUi();
}

/**
 * 選択ファイルを再生できるようにする。ファイルはメモリに読み込まず、ブラウザが必要な分だけ読む
 * @param {File} file 再生するファイル
 */
function loadAudio(file) {
  unloadAudio();
  audioUrl = URL.createObjectURL(file);
  const current = new Audio();
  audio = current;
  current.preload = 'metadata';
  current.src = audioUrl;
  // 破棄済みの古い要素からのイベントは無視する（ファイル差し替え時の誤表示を防ぐ）
  const guard = (fn) => () => { if (audio === current) fn(); };
  current.addEventListener('play', guard(() => {
    updatePlayUi();
    if (!playRaf) playRaf = requestAnimationFrame(playTick);
  }));
  current.addEventListener('pause', guard(updatePlayUi));
  current.addEventListener('ended', guard(() => {
    // 最後まで再生したら先頭に戻す
    waveform.setPlayhead(0, true);
    updatePlayUi();
    updateWaveInfo();
  }));
  current.addEventListener('error', guard(() => {
    showError('このファイルは再生できませんでした。変換は実行できます。');
    updatePlayUi();
  }));
  updatePlayUi();
}

/**
 * 再生/一時停止を切り替える。範囲が選択されていればその範囲だけを再生し、終端で止まる
 */
async function togglePlay() {
  if (!audio || !waveform.hasData()) return;
  if (!audio.paused) {
    audio.pause();
    return;
  }
  const [start, end] = waveform.getSelection();
  let from = waveform.getPlayhead() ?? 0;
  if (start !== null && end !== null) {
    if (from < start || from >= end - 0.05) from = start; // 範囲外・終端なら範囲の先頭から
  } else if (from >= waveform.getDuration() - 0.05) {
    from = 0;
  }
  try {
    audio.currentTime = from;
    await audio.play();
  } catch (e) {
    console.error('再生に失敗:', e);
    showError(`再生できませんでした: ${e.message}`);
  }
}

/** 再生中、毎フレーム再生位置を波形に反映する。選択範囲の終端に達したら停止する */
function playTick() {
  playRaf = 0;
  if (!audio || audio.paused) return;
  const t = audio.currentTime;
  const [start, end] = waveform.getSelection();
  if (start !== null && end !== null && t >= end) {
    audio.pause();
    audio.currentTime = start; // 次の再生で同じ範囲をすぐ聞き直せるよう先頭へ戻す
    waveform.setPlayhead(start, true);
    updateWaveInfo();
    return;
  }
  waveform.setPlayhead(t, true);
  updateWaveInfo();
  playRaf = requestAnimationFrame(playTick);
}

/**
 * 波形がクリックされたとき、再生位置をその場所へ移す（再生中ならそこから続ける）
 * @param {number} time クリック位置（秒）
 */
function onWaveSeek(time) {
  if (audio) {
    try {
      audio.currentTime = time;
    } catch (e) {
      console.warn('シークに失敗:', e);
    }
  }
  updateWaveInfo();
}

/** スクロールバーが操作されたとき、表示範囲を追従させる */
function onScrollbarScroll() {
  if (syncingScroll || !waveform.hasData()) return;
  const sw = el.waveScroll.scrollWidth;
  if (sw <= 0) return;
  scrollDriven = true;
  try {
    waveform.panTo((el.waveScroll.scrollLeft / sw) * waveform.getDuration());
  } finally {
    scrollDriven = false;
  }
}

/**
 * 波形上で範囲が選択されたとき、時間入力欄へ反映する
 * @param {number|null} start 開始秒。解除時は null
 * @param {number|null} end 終了秒。解除時は null
 */
function onWaveSelect(start, end) {
  const total = waveform.getDuration();
  const EDGE = 0.05; // 端に十分近い場合は「指定なし」として空欄にする
  el.startTime.value = start === null || start < EDGE ? '' : formatTime(start);
  el.endTime.value = end === null || end > total - EDGE ? '' : formatTime(end);
  el.zoomSel.disabled = start === null;
  resetPlayheadToSelection(start);
  updateWaveInfo();
}

/**
 * 再生が止まっているときに範囲を選び直したら、再生位置を選択開始位置へ移す。
 * （止めた位置が新しい範囲の内側にあっても、選び直したら範囲の先頭から再生するため）
 * 再生中は、再生を邪魔しないよう何もしない
 * @param {number|null} start 選択開始（秒）。範囲が無い場合は null
 */
function resetPlayheadToSelection(start) {
  if (start === null || (audio && !audio.paused)) return;
  waveform.setPlayhead(start);
}

/** 時間入力欄の内容を、波形上の選択範囲へ反映する（不正な入力は無視） */
function syncSelectionFromInputs() {
  if (!waveform.hasData()) return;
  let start;
  let end;
  try {
    start = parseTime(el.startTime.value, '開始時間');
    end = parseTime(el.endTime.value, '終了時間');
  } catch {
    return; // 入力途中の不正な値では選択を変えない
  }
  const total = waveform.getDuration();
  if (start === null && end === null) {
    waveform.setSelection(null, null);
  } else {
    const s = start ?? 0;
    const e = Math.min(end ?? total, total);
    if (e > s) {
      waveform.setSelection(s, e);
      resetPlayheadToSelection(s);
    }
  }
  el.zoomSel.disabled = waveform.getSelection()[0] === null;
  updateWaveInfo();
}

/**
 * 選択ファイルの波形を生成して表示する。新しいジョブが始まると古い結果は捨てられる
 * @param {File} file 対象ファイル
 */
async function generateWaveform(file) {
  const jobId = ++waveJobId;
  waveform.clear();
  updateWaveInfo();
  ffmpegLog = [];
  setBusy('wave');
  setProgress(0);
  try {
    if (!ffmpeg) ffmpeg = createFFmpeg();
    await ensureLoaded();
    if (jobId !== waveJobId) return;

    await mountInput(file);
    setStatus('波形を生成中…（このあと変換できます）');
    // 映像を除外し、低レートのモノラル16bit PCMにして軽量に波形データを得る
    const code = await ffmpeg.exec(['-i', INPUT_PATH, '-vn', '-ac', '1', '-ar', String(WAVE_RATE), '-f', 's16le', WAVE_NAME]);
    if (jobId !== waveJobId) return;
    if (code !== 0) throw new Error(`ffmpegがエラー終了しました（コード ${code}）`);

    const raw = await ffmpeg.readFile(WAVE_NAME);
    if (jobId !== waveJobId) return;
    if (!raw || raw.byteLength < 2) throw new Error('音声データが空でした');
    // Int16Array は2バイト境界が必要なため、ずれている場合はコピーする
    const bytes = raw.byteOffset % 2 === 0 ? raw : raw.slice();
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    waveform.setData(pcm, WAVE_RATE);
    setStatus('');
    syncSelectionFromInputs(); // 既に時間が入力されていれば選択として反映する
  } catch (e) {
    if (jobId !== waveJobId) return; // 中止・差し替え済みのジョブは何も表示しない
    console.error(e, ffmpegLog.join('\n'));
    if (ffmpegLog.some((l) => l.includes('does not contain any stream'))) {
      audioMissing = true;
      showError(NO_AUDIO_MESSAGE);
      setStatus('');
    } else {
      setStatus('波形を生成できませんでした。変換は実行できます。');
    }
  } finally {
    if (jobId === waveJobId) {
      await cleanupEngine([WAVE_NAME]);
      setProgress(null);
      setBusy(null);
    }
  }
}

/** ファイルを選択状態にする（検証込み）。選択後は波形を自動生成する */
function selectFile(file) {
  if (busyKind === 'convert') return; // 変換中は差し替えない
  showError('');
  el.result.hidden = true;
  audioMissing = false;

  // 波形生成中なら中断して破棄する（新しいジョブに置き換える）
  if (busyKind === 'wave') {
    waveJobId++;
    terminateEngine();
  }
  waveform.clear();
  unloadAudio();
  updateWaveInfo();

  const isWebm = /\.webm$/i.test(file.name) || /webm/i.test(file.type);
  if (!isWebm) {
    selectedFile = null;
    el.dropText.textContent = 'ここにwebmファイルをドラッグ&ドロップ またはクリックして選択';
    showError('webmファイルを選択してください。');
    setProgress(null);
    setBusy(null);
    return;
  }
  selectedFile = file;
  const mb = (file.size / 1024 / 1024).toFixed(1);
  el.dropText.textContent = `選択中: ${file.name}（${mb} MB）`;
  setStatus(file.size > SIZE_WARN_BYTES
    ? '注意: 1GBを超えるファイルです。メモリ不足で失敗する可能性が高いです。'
    : '');
  loadAudio(file);
  generateWaveform(file);
}

/** 変換を実行する */
async function convert() {
  if (!selectedFile || busyKind !== null) return;
  audio?.pause(); // 変換の負荷で再生が途切れないよう止める
  showError('');
  el.result.hidden = true;
  cancelled = false;
  ffmpegLog = [];

  const format = el.format.value; // 変換中に設定が変わっても、開始時点の形式で一貫させる
  const spec = FORMATS[format];
  let args;
  try {
    args = buildArgs();
  } catch (e) {
    showError(e.message);
    return;
  }

  setBusy('convert');
  setProgress(0);
  try {
    if (!ffmpeg) ffmpeg = createFFmpeg();
    await ensureLoaded();
    await mountInput(selectedFile);

    setStatus(format === 'mp4' ? '変換中…（映像の再エンコードには時間がかかります）' : '変換中…');
    const code = await ffmpeg.exec(args);
    if (cancelled) return;
    if (code !== 0) throw new Error(`ffmpegがエラー終了しました（コード ${code}）`);

    const out = await ffmpeg.readFile(spec.output);
    if (!out || out.length === 0) throw new Error('出力ファイルが空です。時間指定が音声の長さを超えている可能性があります。');
    showResult(out, spec);
    setProgress(100);
    setStatus('変換が完了しました。');
  } catch (e) {
    if (cancelled) return; // 中止時はエラー扱いにしない
    console.error(e, ffmpegLog.join('\n'));
    // 入力にトラックが無い場合（音声なし→mp3、映像なし→mp4）は専用の文言で案内する
    if (format === 'mp3' && ffmpegLog.some((l) => l.includes('does not contain any stream'))) {
      audioMissing = true;
      showError(NO_AUDIO_MESSAGE);
      setStatus('');
      setProgress(null);
      return;
    }
    if (format === 'mp4' && ffmpegLog.some((l) => l.includes('matches no streams'))) {
      showError(NO_VIDEO_MESSAGE);
      setStatus('');
      setProgress(null);
      return;
    }
    const tail = ffmpegLog.slice(-3).join('\n');
    showError(`変換に失敗しました: ${e.message}${tail ? '\n\n' + tail : ''}\n\n大きなファイルの場合はメモリ不足の可能性があります。`);
    setStatus('');
    setProgress(null);
  } finally {
    // 次回のためにマウント解除と出力ファイルの掃除を行う
    if (!cancelled) await cleanupEngine(OUTPUT_NAMES);
    isMounted = false;
    setBusy(null);
  }
}

/**
 * 変換結果のダウンロードリンクを表示する
 * @param {Uint8Array} bytes 変換結果
 * @param {{mime: string, ext: string}} spec 出力形式の定義
 */
function showResult(bytes, spec) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(new Blob([bytes], { type: spec.mime }));
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = `${selectedFile.name.replace(/\.webm$/i, '')}.${spec.ext}`;
  a.textContent = `${a.download} をダウンロード（${(bytes.length / 1024 / 1024).toFixed(2)} MB）`;
  el.result.replaceChildren(a);
  el.result.hidden = false;
}

/** 実行中の処理（波形生成または変換）を中止する。ffmpegを強制終了するため、次回実行時にエンジンを再読み込みする */
function cancel() {
  if (busyKind === 'wave') {
    waveJobId++; // 実行中の波形ジョブの結果を無効にする
    terminateEngine();
    setProgress(null);
    setStatus('波形の生成を中止しました。変換は実行できます。');
    setBusy(null);
    return;
  }
  cancelled = true;
  terminateEngine();
  setProgress(null);
  setStatus('変換を中止しました。');
  setBusy(null);
}

// ---- イベント登録 ----
const waveform = createWaveform(el.wave, onWaveSelect, onWaveView, onWaveSeek);

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files[0]) selectFile(el.fileInput.files[0]);
  el.fileInput.value = ''; // 同じファイルを再選択しても change が発火するようにする
});
el.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropzone.classList.add('dragover'); });
el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('dragover'));
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) selectFile(file);
});
el.format.addEventListener('change', onFormatChange);
el.convertBtn.addEventListener('click', convert);
el.cancelBtn.addEventListener('click', cancel);
el.playBtn.addEventListener('click', togglePlay);
el.wave.addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); togglePlay(); } // 波形にフォーカスがあるときはスペースで再生/停止
});
el.zoomIn.addEventListener('click', () => waveform.zoomBy(0.5));
el.zoomOut.addEventListener('click', () => waveform.zoomBy(2));
el.zoomFit.addEventListener('click', () => waveform.zoomFit());
el.zoomSel.addEventListener('click', () => waveform.zoomToSelection());
el.waveScroll.addEventListener('scroll', onScrollbarScroll);
el.startTime.addEventListener('input', syncSelectionFromInputs);
el.endTime.addEventListener('input', syncSelectionFromInputs);
window.addEventListener('resize', () => waveform.draw());

onFormatChange(); // 再読み込み時にブラウザが復元した選択値に、表示を合わせる

if (typeof WebAssembly === 'undefined') {
  showError('このブラウザはWebAssemblyに対応していません。最新のChromeまたはEdgeをお使いください。');
}
