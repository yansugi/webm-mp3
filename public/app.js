// webm → mp3 変換アプリ本体（ffmpeg.wasm をブラウザ内で実行する）
import { FFmpeg } from '/vendor/ffmpeg/index.js';

const SIZE_WARN_BYTES = 1024 * 1024 * 1024; // これを超えると失敗の可能性が高い旨を警告する（入力はWORKERFSでコピーしないが出力・wasm上限に依存）
const MOUNT_DIR = '/mnt';                    // WORKERFSのマウント先
const INPUT_NAME = 'input.webm';             // マウント時に付ける固定名（元のファイル名に依存しないため）
const INPUT_PATH = `${MOUNT_DIR}/${INPUT_NAME}`;
const OUTPUT_NAME = 'output.mp3';

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), dropText: $('dropText'), fileInput: $('fileInput'),
  bitrate: $('bitrate'), startTime: $('startTime'), endTime: $('endTime'),
  convertBtn: $('convertBtn'), cancelBtn: $('cancelBtn'),
  progress: $('progress'), status: $('status'), error: $('error'), result: $('result'),
};

let ffmpeg = null;       // FFmpegインスタンス（中止時は作り直す）
let loaded = false;      // コアの読み込み済みフラグ
let selectedFile = null; // 選択中のファイル
let objectUrl = null;    // ダウンロード用URL（解放管理用）
let cancelled = false;   // ユーザーが中止したか
let ffmpegLog = [];      // 直近のffmpegログ（エラー解析用）
let isMounted = false;   // WORKERFSをマウント中か

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

/** 変換中かどうかに応じてUIの有効/無効を切り替える */
function setBusy(busy) {
  el.convertBtn.disabled = busy || !selectedFile;
  el.cancelBtn.hidden = !busy;
  el.bitrate.disabled = el.startTime.disabled = el.endTime.disabled = busy;
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
  const start = parseTime(el.startTime.value, '開始時間');
  const end = parseTime(el.endTime.value, '終了時間');
  if (start !== null && end !== null && end <= start) {
    throw new Error('終了時間は開始時間より後にしてください');
  }

  const args = [];
  if (start !== null) args.push('-ss', String(start)); // 入力前に指定すると高速にシークできる
  args.push('-i', INPUT_PATH);
  if (end !== null) args.push('-t', String(end - (start ?? 0)));
  // -vn: 映像を除外して音声のみを取り出す
  args.push('-vn', '-codec:a', 'libmp3lame', '-b:a', `${el.bitrate.value}k`, OUTPUT_NAME);
  return args;
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

/** ファイルを選択状態にする（検証込み） */
function selectFile(file) {
  showError('');
  el.result.hidden = true;
  const isWebm = /\.webm$/i.test(file.name) || /webm/i.test(file.type);
  if (!isWebm) {
    selectedFile = null;
    el.dropText.textContent = 'ここにwebmファイルをドラッグ&ドロップ またはクリックして選択';
    showError('webmファイルを選択してください。');
    setBusy(false);
    return;
  }
  selectedFile = file;
  const mb = (file.size / 1024 / 1024).toFixed(1);
  el.dropText.textContent = `選択中: ${file.name}（${mb} MB）`;
  setStatus(file.size > SIZE_WARN_BYTES
    ? '注意: 1GBを超えるファイルです。メモリ不足で失敗する可能性が高いです。'
    : '');
  setBusy(false);
}

/** 変換を実行する */
async function convert() {
  if (!selectedFile) return;
  showError('');
  el.result.hidden = true;
  cancelled = false;
  ffmpegLog = [];

  let args;
  try {
    args = buildArgs();
  } catch (e) {
    showError(e.message);
    return;
  }

  setBusy(true);
  setProgress(0);
  try {
    if (!ffmpeg) ffmpeg = createFFmpeg();
    await ensureLoaded();

    // 入力ファイルをコピーせずWORKERFSで直接参照する（メモリ使用量の削減）
    try {
      await ffmpeg.createDir(MOUNT_DIR);
    } catch {
      /* 既に存在する場合は無視 */
    }
    const mounted = await ffmpeg.mount('WORKERFS', { blobs: [{ name: INPUT_NAME, data: selectedFile }] }, MOUNT_DIR);
    if (!mounted) throw new Error('入力ファイルのマウントに失敗しました');
    isMounted = true;

    setStatus('変換中…');
    const code = await ffmpeg.exec(args);
    if (cancelled) return;
    if (code !== 0) throw new Error(`ffmpegがエラー終了しました（コード ${code}）`);

    const out = await ffmpeg.readFile(OUTPUT_NAME);
    if (!out || out.length === 0) throw new Error('出力ファイルが空です。時間指定が音声の長さを超えている可能性があります。');
    showResult(out);
    setProgress(100);
    setStatus('変換が完了しました。');
  } catch (e) {
    if (cancelled) return; // 中止時はエラー扱いにしない
    console.error(e, ffmpegLog.join('\n'));
    // 音声トラックが無い入力（映像のみのwebm）は専用の文言で案内する
    if (ffmpegLog.some((l) => l.includes('does not contain any stream'))) {
      showError('このwebmファイルには音声トラックが含まれていないため、mp3に変換できません。\n（画面録画で「音声を共有」をオフにして録画したファイルなどが該当します）');
      setStatus('');
      setProgress(null);
      return;
    }
    const tail = ffmpegLog.slice(-3).join('\n');
    showError(`変換に失敗しました: ${e.message}${tail ? '\n\n' + tail : ''}\n\n大きなファイルの場合はメモリ不足の可能性があります。`);
    setStatus('');
    setProgress(null);
  } finally {
    // 次回のためにマウント解除と出力ファイルの掃除を行う（失敗しても無視してよい）
    if (!cancelled && ffmpeg && loaded) {
      if (isMounted) {
        try { await ffmpeg.unmount(MOUNT_DIR); } catch (e) { console.warn('unmount失敗:', e); }
      }
      try { await ffmpeg.deleteFile(OUTPUT_NAME); } catch { /* 存在しない場合は無視 */ }
    }
    isMounted = false;
    setBusy(false);
  }
}

/** 変換結果のダウンロードリンクを表示する */
function showResult(bytes) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = selectedFile.name.replace(/\.webm$/i, '') + '.mp3';
  a.textContent = `${a.download} をダウンロード（${(bytes.length / 1024 / 1024).toFixed(2)} MB）`;
  el.result.replaceChildren(a);
  el.result.hidden = false;
}

/** 変換を中止する。ffmpegを強制終了するため、次回実行時にエンジンを再読み込みする */
function cancel() {
  cancelled = true;
  try {
    ffmpeg.terminate();
  } catch (e) {
    console.error('中止処理でエラー:', e);
  }
  ffmpeg = null;
  loaded = false;
  setProgress(null);
  setStatus('変換を中止しました。');
  setBusy(false);
}

// ---- イベント登録 ----
el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files[0]) selectFile(el.fileInput.files[0]);
});
el.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropzone.classList.add('dragover'); });
el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('dragover'));
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) selectFile(file);
});
el.convertBtn.addEventListener('click', convert);
el.cancelBtn.addEventListener('click', cancel);

if (typeof WebAssembly === 'undefined') {
  showError('このブラウザはWebAssemblyに対応していません。最新のChromeまたはEdgeをお使いください。');
}
