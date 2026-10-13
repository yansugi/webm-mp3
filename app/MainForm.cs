using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WebmMp3;

/// <summary>WebView2 を1枚表示するメインウィンドウ。画面本体は www/ 配下のHTML/JS</summary>
public sealed class MainForm : Form
{
    // 仮想ホスト名。www/ フォルダをこのホスト名に対応づけて配信する（サーバー不要）
    private const string HostName = "app.local";
    private static readonly string StartUrl = $"https://{HostName}/index.html";

    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };

    /// <summary>ウィンドウを初期化し、表示後にWebView2を準備する</summary>
    public MainForm()
    {
        Text = "webm → mp3 / mp4 変換";
        Width = 1280;
        Height = 900;
        StartPosition = FormStartPosition.CenterScreen;
        ApplyIcon();
        Controls.Add(_webView);
        Load += OnFormLoad;
    }

    /// <summary>exeに埋め込まれたアイコンをウィンドウに設定する（失敗しても動作には影響しないため無視する）</summary>
    private void ApplyIcon()
    {
        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"アイコン設定に失敗: {ex.Message}");
        }
    }

    /// <summary>フォーム表示時にWebView2を初期化する。失敗時は内容を通知して終了する</summary>
    private async void OnFormLoad(object? sender, EventArgs e)
    {
        try
        {
            await InitializeWebViewAsync();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowFatal("WebView2 ランタイムが見つかりません。\nMicrosoft Edge WebView2 Runtime をインストールしてください。");
        }
        catch (Exception ex)
        {
            ShowFatal($"初期化に失敗しました。\n\n{ex.Message}");
        }
    }

    /// <summary>WebView2の環境作成・仮想ホスト割り当て・各種制限の設定を行い、画面を開く</summary>
    private async Task InitializeWebViewAsync()
    {
        var wwwPath = Path.Combine(AppContext.BaseDirectory, "www");
        if (!Directory.Exists(wwwPath))
        {
            throw new DirectoryNotFoundException($"画面ファイルが見つかりません: {wwwPath}");
        }

        // ユーザーデータは実行フォルダ外（ローカルAppData）に置く。共有フォルダ上のexeでも書き込み可能にするため
        var userDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WebmMp3",
            "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(null, userDataDir);
        await _webView.EnsureCoreWebView2Async(env);

        var core = _webView.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.SetVirtualHostNameToFolderMapping(HostName, wwwPath, CoreWebView2HostResourceAccessKind.DenyCors);

        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.DownloadStarting += OnDownloadStarting;

        core.Navigate(StartUrl);
    }

    /// <summary>アプリ内のホスト以外への遷移（外部サイト・外部ファイル）を禁止する</summary>
    private static void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Host, HostName, StringComparison.OrdinalIgnoreCase))
        {
            e.Cancel = true;
        }
    }

    /// <summary>新規ウィンドウの表示を禁止する</summary>
    private static void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
    }

    /// <summary>ダウンロード時に保存先を選ぶダイアログを表示する（キャンセルならダウンロードを中止）</summary>
    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        try
        {
            // 拡張子（.mp3 / .mp4 など）に応じて保存ダイアログのフィルタを切り替える
            var ext = Path.GetExtension(e.ResultFilePath);
            var label = string.IsNullOrEmpty(ext) ? "ファイル" : $"{ext.TrimStart('.').ToUpperInvariant()} ファイル";
            using var dialog = new SaveFileDialog
            {
                FileName = Path.GetFileName(e.ResultFilePath),
                Filter = string.IsNullOrEmpty(ext)
                    ? "すべてのファイル (*.*)|*.*"
                    : $"{label} (*{ext})|*{ext}|すべてのファイル (*.*)|*.*",
                OverwritePrompt = true,
            };

            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                e.ResultFilePath = dialog.FileName;
                e.Handled = true; // 既定のダウンロードUIは出さない
            }
            else
            {
                e.Cancel = true;
            }
        }
        catch (Exception ex)
        {
            e.Cancel = true;
            MessageBox.Show(this, $"保存先の選択に失敗しました。\n\n{ex.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>致命的なエラーを表示してアプリを終了する</summary>
    private void ShowFatal(string message)
    {
        MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }
}
