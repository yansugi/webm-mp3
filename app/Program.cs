namespace WebmMp3;

/// <summary>アプリケーションのエントリポイント</summary>
internal static class Program
{
    /// <summary>メインフォームを起動する。未処理例外はメッセージボックスで通知する</summary>
    [STAThread]
    private static void Main()
    {
        try
        {
            ApplicationConfiguration.Initialize();
            Application.Run(new MainForm());
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"予期しないエラーが発生しました。\n\n{ex.Message}",
                "webm → mp3 変換",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
