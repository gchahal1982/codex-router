import Foundation
import WidgetKit

@MainActor
extension RouterStore {
  func widgetSnapshot(now: Date = Date()) -> RouterWidgetSnapshot {
    var availableProviders = visibleUsageProviders
    if !availableProviders.contains(where: { $0.id == RouterWidgetSnapshot.defaultUsageSourceID }),
       let codex = usageProviderChoices.first(where: {
         $0.id == RouterWidgetSnapshot.defaultUsageSourceID
       }) {
      availableProviders.insert(codex, at: 0)
    }
    let usageSources = availableProviders.map { provider in
      let daily = dailyUsage(for: provider.id, days: 7).map {
        RouterWidgetDailyPoint(
          date: $0.date,
          tokens: RouterWidgetTokenCount.from($0.tokens)
        )
      }
      return RouterWidgetUsageSource(
        id: provider.id,
        name: provider.id == RouterWidgetSnapshot.defaultUsageSourceID
          ? "Codex"
          : provider.shortName,
        todayTokens: daily.last?.tokens ?? 0,
        daily: daily
      )
    }
    return RouterWidgetSnapshot(
      schemaVersion: RouterWidgetSnapshot.schemaVersion,
      generatedAt: now,
      activityState: activityState.rawValue,
      activeChatCount: activeChatCount,
      selectedProviderID: selectedUsageProviderID,
      selectedProviderName: selectedUsageProvider.shortName,
      todayTokens: RouterWidgetTokenCount.from(selectedTodayTokens),
      daily: dailyUsage(days: 7).map {
        RouterWidgetDailyPoint(
          date: $0.date,
          tokens: RouterWidgetTokenCount.from($0.tokens)
        )
      },
      quotas: desktopQuotaRows.map {
        RouterWidgetQuota(
          id: $0.id,
          providerID: $0.providerID,
          providerName: $0.providerName,
          label: $0.label,
          remainingPercent: RouterWidgetQuota.normalizedRemainingPercent(
            $0.remainingPercent
          ),
          resetAt: $0.resetAt.map(Date.init(timeIntervalSince1970:))
        )
      },
      usageSources: usageSources
    )
  }

  func publishWidgetSnapshot(now: Date = Date()) {
    let snapshot = widgetSnapshot(now: now)
    guard let destination = RouterWidgetSnapshotStore.hostSnapshotURL() else { return }
    let didWrite = (try? RouterWidgetSnapshotStore.write(
      snapshot,
      to: destination,
      now: now
    )) == true

    if didWrite {
      WidgetCenter.shared.reloadTimelines(ofKind: RouterWidgetSnapshot.kind)
      WidgetCenter.shared.reloadTimelines(ofKind: RouterWidgetSnapshot.resetKind)
    }
  }
}
