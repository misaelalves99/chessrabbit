import LegalDoc from "@/components/LegalDoc";

export default function Privacy() {
  return <LegalDoc title="Local data and privacy" standfirst="How the community edition stores and uses your data" updated="2 October 2026">
    <h2>On your computer</h2>
    <p>In the default local setup, games, repertoires, annotations, training progress and engine results are stored in a PostgreSQL Docker volume on your computer. Redis stores the job queue and temporary state. Browser storage holds session tokens and display settings.</p>
    <h2>Optional online features</h2>
    <p>Connecting a Lichess or Chess.com account sends its public username to that service to import games. Opponent preparation and player insights fetch public games when requested. Choosing the live Lichess explorer sends the board position to its opening explorer. These features require internet access.</p>
    <h2>Control your data</h2>
    <p>You can export or delete games in the app. Back up the database before removing Docker volumes. Stopping containers preserves data; removing their volumes permanently deletes it.</p>
    <h2>Shared installations</h2>
    <p>A server operated by somebody else stores data on that server. Its operator is responsible for explaining their hosting, access and retention practices. Local mode is intended for a single person using localhost.</p>
  </LegalDoc>;
}
