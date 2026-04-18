class ForgeHub < Formula
  desc "Multi-channel messaging hub for Claude Code (WeChat / Telegram / Feishu / iMessage)"
  homepage "https://github.com/LinekForge/forge-hub"
  url "https://github.com/LinekForge/forge-hub.git",
      tag:      "v0.2.0",
      revision: "HEAD"
  license "MIT"
  head "https://github.com/LinekForge/forge-hub.git", branch: "main"

  depends_on "oven-sh/bun/bun"
  depends_on :macos # launchd + iMessage require macOS

  def install
    # Install the full source tree into libexec
    libexec.install Dir["*"]
    libexec.install ".gitignore" if File.exist?(".gitignore")

    # Run bun install for hub-server and hub-client dependencies
    cd libexec do
      # hub-server deps are installed by cli.ts into ~/.forge-hub,
      # but we also need hub-client deps bundled for MCP registration.
      # The actual deploy is done by `forge-hub install` post-install.
    end

    # Create a wrapper script that invokes cli.ts via bun
    (bin/"forge-hub").write <<~SH
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/cli.ts" "$@"
    SH
  end

  def post_install
    ohai "Running forge-hub install..."
    system bin/"forge-hub", "install"
  end

  def caveats
    <<~EOS
      Forge Hub has been installed and the hub server is running via launchd.

      Next steps:
        1. Configure channel credentials (WeChat / Telegram / Feishu / iMessage):
             cat #{libexec}/配置.md

        2. Start Claude Code with hub channel:
             claude --dangerously-load-development-channels server:hub

        3. Verify:
             fh hub status

      To uninstall (keeps state in ~/.forge-hub/state/):
        forge-hub uninstall

      To diagnose issues:
        forge-hub doctor
    EOS
  end

  test do
    assert_match "forge-hub", shell_output("#{bin}/forge-hub --help")
  end
end
