import LegalDoc from "@/components/LegalDoc";

export default function Terms() {
  return <LegalDoc title="Software license" standfirst="ChessRabbit community edition" updated="3 October 2026">
    <h2>Free and open source</h2>
    <p>ChessRabbit is distributed under the GNU General Public License version 3. You may use, study, modify and redistribute it under that license. The LICENSE file in the source repository contains the full terms.</p>
    <h2>No subscriptions</h2>
    <p>Every feature is available without payment or a license key. Donations are optional support for development and do not unlock paid features, warranties or private licenses.</p>
    <h2>Warranty</h2>
    <p>The software is provided without warranty to the extent permitted by law. Engine evaluations, opening suggestions, accuracy scores and training statistics are estimates.</p>
    <h2>Other projects and data</h2>
    <p>Third-party libraries, chess engines, neural-network files, tablebases, games and datasets retain their own licenses or terms. See the open-source credits, THIRD_PARTY_NOTICES.md and LEGAL.md. Use imported games and external services according to their terms and data licenses.</p>
  </LegalDoc>;
}
