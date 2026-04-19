class ForgeHub < Formula
  desc "Multi-channel messaging hub for Claude Code (WeChat / Telegram / Feishu / iMessage)"
  homepage "https://github.com/LinekForge/forge-hub"
  url "https://github.com/LinekForge/forge-hub.git",
      tag:      "v0.2.0",
      revision: "20e0e4449c60235b91a50e5876acf70f6282cfe7"
  license "MIT"
  head "https://github.com/LinekForge/forge-hub.git", branch: "main"

  depends_on "oven-sh/bun/bun"
  depends_on :macos # launchd + iMessage require macOS

  def install
    # Install the full source tree into libexec
    libexec.install Dir["*"]
    libexec.install ".gitignore" if File.exist?(".gitignore")

    # Note: hub-server / hub-client deps are installed by cli.ts into
    # ~/.forge-hub and ~/.claude/channels/hub/ when the user runs the
    # post-install `forge-hub install` step (see caveats).

    # Create a wrapper script that invokes cli.ts via bun
    (bin/"forge-hub").write <<~SH
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/cli.ts" "$@"
    SH
  end

  def caveats
    <<~EOS
      Forge Hub is installed. Run the one-time setup to deploy the hub server,
      MCP registration, and launchd service:

        forge-hub install

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
