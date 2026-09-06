import Foundation
import Testing

@testable import CodexRouterTray

@Suite("Desktop widget presentation")
struct DesktopWidgetPresentationTests {
  @Test("today tokens render as a full scannable count")
  func tokenCountFormatting() {
    #expect(DesktopWidgetPresentation.tokenCountLabel(0) == "0")
    #expect(DesktopWidgetPresentation.tokenCountLabel(1_410_272_747) == "1,410,272,747")
    #expect(DesktopWidgetPresentation.tokenCountLabel(-50) == "0")
    #expect(DesktopWidgetPresentation.tokenCountLabel(.infinity) == "0")
  }

  @Test("quota colors change only at the warning boundaries")
  func quotaSeverityBoundaries() {
    #expect(DesktopWidgetPresentation.quotaSeverity(31) == .healthy)
    #expect(DesktopWidgetPresentation.quotaSeverity(30) == .warning)
    #expect(DesktopWidgetPresentation.quotaSeverity(11) == .warning)
    #expect(DesktopWidgetPresentation.quotaSeverity(10) == .critical)
  }

  @Test("quota accessibility carries provider, window, remaining amount, and reset")
  func quotaAccessibility() {
    let now = Date(timeIntervalSince1970: 1_770_000_000)
    let row = DesktopQuotaRow(
      id: "openai-primary",
      providerID: "openai",
      providerName: "ChatGPT",
      label: "5-hour limit",
      remainingPercent: 42,
      resetAt: now.addingTimeInterval(2 * 3600 + 12 * 60).timeIntervalSince1970
    )
    #expect(
      DesktopWidgetPresentation.quotaAccessibilityLabel(row, now: now)
        == "ChatGPT, 5-hour limit, 42 percent left, in 2h 12m"
    )
  }
}

@Suite("Island account leftover table")
struct IslandAccountQuotaPresentationTests {
  @Test("missing leftovers stay as an em dash")
  func missingPercent() {
    #expect(IslandAccountQuotaPresentation.percentText(nil) == "—")
    #expect(IslandAccountQuotaPresentation.percentText(.nan) == "—")
  }

  @Test("leftovers round to a scannable percent")
  func roundedPercent() {
    #expect(IslandAccountQuotaPresentation.percentText(0) == "0%")
    #expect(IslandAccountQuotaPresentation.percentText(20.6) == "21%")
    #expect(IslandAccountQuotaPresentation.percentText(59.2) == "59%")
  }

  @Test("table height covers a header plus every account row")
  func tableHeight() {
    #expect(IslandAccountQuotaPresentation.tableHeight(rows: 0) == 34)
    #expect(IslandAccountQuotaPresentation.tableHeight(rows: 6) == CGFloat(16 + 6 * 18))
  }

  @Test("5-hour return times stay compact")
  func fiveHourBackText() {
    let now = Date(timeIntervalSince1970: 1_770_000_000)
    #expect(IslandAccountQuotaPresentation.fiveHourBackText(nil, now: now) == "—")
    #expect(IslandAccountQuotaPresentation.fiveHourBackText(now.timeIntervalSince1970, now: now) == "now")
    #expect(
      IslandAccountQuotaPresentation.fiveHourBackText(
        now.addingTimeInterval(45 * 60).timeIntervalSince1970,
        now: now
      ) == "45m"
    )
    #expect(
      IslandAccountQuotaPresentation.fiveHourBackText(
        now.addingTimeInterval(2 * 3600 + 14 * 60).timeIntervalSince1970,
        now: now
      ) == "2h14"
    )
    #expect(
      IslandAccountQuotaPresentation.fiveHourBackText(
        now.addingTimeInterval(3 * 3600).timeIntervalSince1970,
        now: now
      ) == "3h"
    )
  }
}
