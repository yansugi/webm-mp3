// 出力形式ごとの ffmpeg 引数の組み立て（DOMに依存しない純粋な関数）

/** 出力形式ごとの定義（出力ファイル名・MIME・拡張子） */
export const FORMATS = {
  mp3: { output: 'output.mp3', mime: 'audio/mpeg', ext: 'mp3' },
  mp4: { output: 'output.mp4', mime: 'video/mp4', ext: 'mp4' },
};

/** 画質プリセット（x264の CRF が小さいほど高画質、preset が速いほど変換が速い） */
const QUALITY_PRESETS = {
  high: { crf: '20', preset: 'veryfast' },
  standard: { crf: '26', preset: 'veryfast' },
  fast: { crf: '30', preset: 'ultrafast' },
};

/**
 * 解像度の指定から、映像フィルタ（scale）の文字列を作る。
 * yuv420p（H.264の標準的な再生互換）には偶数の幅・高さが必要なため、必ず偶数に丸める。
 * 元より大きくは拡大しない
 * @param {string} resolution 'orig' または高さ（例: '720'）
 * @returns {string} -vf に渡す文字列
 */
export function videoFilter(resolution) {
  // setsar=1: 丸めで生じるわずかな画素アスペクト比のずれを正規化する（正方画素にする）
  if (resolution === 'orig') return 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1';
  const height = Number(resolution);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`解像度の指定が不正です: ${resolution}`);
  return `scale=-2:'2*trunc(min(${height},ih)/2)',setsar=1`;
}

/**
 * 変換用の ffmpeg 引数を組み立てる
 * @param {object} opts 変換設定
 * @param {'mp3'|'mp4'} opts.format 出力形式
 * @param {string} opts.inputPath 入力ファイルのパス
 * @param {number|null} opts.start 開始秒（null で先頭から）
 * @param {number|null} opts.end 終了秒（null で最後まで）
 * @param {string|number} opts.audioBitrate 音声ビットレート（kbps）
 * @param {string} [opts.resolution] mp4 の解像度（'orig' または高さ）
 * @param {string} [opts.quality] mp4 の画質（'high' | 'standard' | 'fast'）
 * @returns {string[]} ffmpeg の引数配列
 * @throws {Error} 設定が不正な場合
 */
export function buildFfmpegArgs({ format, inputPath, start, end, audioBitrate, resolution = 'orig', quality = 'standard' }) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`未対応の出力形式です: ${format}`);
  if (start !== null && end !== null && end <= start) {
    throw new Error('終了時間は開始時間より後にしてください');
  }

  const args = [];
  if (start !== null) args.push('-ss', String(start)); // 入力前に指定すると高速にシークできる
  args.push('-i', inputPath);
  if (end !== null) args.push('-t', String(end - (start ?? 0)));

  if (format === 'mp3') {
    // -vn: 映像を除外して音声のみを取り出す
    args.push('-vn', '-codec:a', 'libmp3lame', '-b:a', `${audioBitrate}k`);
  } else {
    const q = QUALITY_PRESETS[quality];
    if (!q) throw new Error(`画質の指定が不正です: ${quality}`);
    args.push(
      '-map', '0:v:0',          // 映像は必須（無ければエラーにして利用者へ案内する）
      '-map', '0:a:0?',         // 音声は任意（映像のみのwebmも変換できる）
      '-vf', videoFilter(resolution),
      '-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf,
      '-pix_fmt', 'yuv420p',    // 幅広いプレーヤーで再生できる形式
      '-c:a', 'aac', '-b:a', `${audioBitrate}k`,
      '-movflags', '+faststart', // 先頭にメタデータを置き、再生開始を早くする
    );
  }
  args.push(spec.output);
  return args;
}
