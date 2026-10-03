import LegalDoc from "@/components/LegalDoc";

export default function Privacy() {
  return <LegalDoc title="Local data and privacy" standfirst="How ChessRabbit stores and uses your data" updated="3 October 2026">
    <h2>On your computer</h2>
    <p>The Windows app runs on your computer. Games, repertoires, annotations, training progress, engine results, settings and logs are stored in your local ChessRabbit data folder, normally under %APPDATA%/ChessRabbit/local.</p>
    <h2>Internet use</h2>
    <p>Local PGN analysis with Stockfish works after installation without creating an online account. Internet access is used for downloading the app, updates and optional online features such as Lichess, Chess.com, opening explorers or external engine and dataset downloads.</p>
    <h2>Telemetry</h2>
    <p>ChessRabbit does not intentionally include analytics, advertising trackers or telemetry in the desktop app. A build hosted or modified by somebody else may behave differently, and that operator is responsible for explaining their hosting and retention practices.</p>
    <h2>Your control</h2>
    <p>You can back up or delete your local ChessRabbit data folder while the app is closed. Backups may contain private games and local database credentials, so treat them as private.</p>
    <h2>Community spaces</h2>
    <p>GitHub issues, discussions, pull requests and comments are public when the repository is public. Do not post passwords, private games, personal information or secret tokens in public reports.</p>
  </LegalDoc>;
}
