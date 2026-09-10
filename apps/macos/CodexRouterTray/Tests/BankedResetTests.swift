import Foundation
import Testing

@testable import CodexRouterTray

// A banked reset is a one-way spend, so the panel must not imply it worked. The
// router returns the app-server's outcome verbatim and the row reports that,
// including the cases where nothing was spent.
@Suite("Banked resets")
struct BankedResetTests {
  private func row(resetCredits: ChatGptAccountResetCredits?, session: String? = "usable")
    -> ChatGptAccountUsageRow
  {
    ChatGptAccountUsageRow(
      id: "chatgpt_abcdefghijklmnop",
      label: "gc@veerone.com",
      state: "active",
      session: session,
      planType: "pro",
      fiveHour: nil,
      weekly: ChatGptAccountQuotaWindow(
        remainingPercent: 0,
        usedPercent: 100,
        windowDurationMins: 10_080,
        resetsAt: nil
      ),
      error: nil,
      preferred: false,
      resetCredits: resetCredits
    )
  }

  @Test("a row offers a redeem only when a credit is actually available")
  func availability() {
    #expect(row(resetCredits: nil).bankedResetCount == 0)
    #expect(row(resetCredits: nil).canRedeemBankedReset == false)
    #expect(row(resetCredits: ChatGptAccountResetCredits(availableCount: 0)).canRedeemBankedReset == false)
    #expect(row(resetCredits: ChatGptAccountResetCredits(availableCount: 3)).bankedResetCount == 3)
    #expect(row(resetCredits: ChatGptAccountResetCredits(availableCount: 3)).canRedeemBankedReset)
    // An expired login cannot spend anything until it signs in again.
    #expect(
      row(resetCredits: ChatGptAccountResetCredits(availableCount: 1), session: "expired")
        .canRedeemBankedReset == false
    )
  }

  @Test("a negative count from a bad payload never advertises a credit")
  func negativeCount() {
    #expect(row(resetCredits: ChatGptAccountResetCredits(availableCount: -4)).bankedResetCount == 0)
    #expect(row(resetCredits: ChatGptAccountResetCredits(availableCount: -4)).canRedeemBankedReset == false)
  }

  @Test("each unsuccessful outcome explains itself instead of claiming a reset")
  func outcomeMessages() {
    let label = "gc@veerone.com"
    #expect(RouterStore.resetCreditFailureMessage("noCredit", label: label).contains(label))
    #expect(RouterStore.resetCreditFailureMessage("noCredit", label: label).contains("no banked reset"))
    #expect(
      RouterStore.resetCreditFailureMessage("nothingToReset", label: label)
        .contains("not rate limited")
    )
    #expect(
      RouterStore.resetCreditFailureMessage("alreadyRedeemed", label: label)
        .contains("already used")
    )
    #expect(RouterStore.resetCreditFailureMessage(nil, label: label).contains("could not be used"))
  }

  @Test("the usage payload decodes redeemable banked resets")
  func decoding() throws {
    let json = """
      {
        "fetchedAt": "2026-09-10T07:23:08.502Z",
        "accounts": [
          {
            "id": "default",
            "label": "Current Codex login",
            "state": "active",
            "session": "usable",
            "weekly": { "remainingPercent": 0 },
            "resetCredits": { "availableCount": 2 }
          },
          {
            "id": "chatgpt_abcdefghijklmnop",
            "label": "gc@veerone.com",
            "state": "active",
            "session": "usable",
            "weekly": { "remainingPercent": 0 }
          }
        ]
      }
      """
    let snapshot = try JSONDecoder().decode(
      ChatGptAccountsUsageSnapshot.self,
      from: Data(json.utf8)
    )
    #expect(snapshot.accounts[0].bankedResetCount == 2)
    #expect(snapshot.accounts[0].canRedeemBankedReset)
    #expect(snapshot.accounts[1].bankedResetCount == 0)
  }
}
