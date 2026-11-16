// Mandate for iPhone: give shoppers spending rules, and only deal with the exceptions.
import SwiftUI
import UserNotifications

@main
struct MandateApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .preferredColorScheme(.dark)
                .tint(.white)
                .task { await store.resume() }
        }
    }
}

/// Lets a request notification show while the app is open, too.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}

enum AppTab: Hashable {
    case home, shoppers, activity, you
}

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch store.phase {
            case .launching:
                ZStack {
                    LightField()
                    VStack(spacing: 18) {
                        Wordmark()
                        ProgressView()
                    }
                }
            case .signedOut:
                SignInView()
            case .signedIn:
                if store.settingUp {
                    SetupView()
                } else {
                    // A fresh set of tabs for each person who signs in.
                    MainTabs().id(store.customer?.id)
                }
            }
        }
        .animation(.smooth(duration: 0.35), value: store.phase)
        .animation(.smooth(duration: 0.35), value: store.settingUp)
        .onChange(of: scenePhase) { _, next in
            guard store.phase == .signedIn else { return }
            if next == .active {
                store.start()
                Task { await store.refresh() }
            } else if next == .background {
                store.stop()
            }
        }
    }
}

struct MainTabs: View {
    @Environment(AppStore.self) private var store
    @State private var tab: AppTab = .home

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                HomeView(tab: $tab)
            }
            .badge(store.requests.count)
            Tab("Shoppers", systemImage: "person.2", value: AppTab.shoppers) {
                ShoppersView()
            }
            Tab("Activity", systemImage: "list.bullet", value: AppTab.activity) {
                ActivityView()
            }
            Tab("You", systemImage: "person.crop.circle", value: AppTab.you) {
                YouView()
            }
        }
        .showsBanner()
        .sensoryFeedback(trigger: store.banner) { _, banner in
            guard let banner else { return nil }
            return banner.blocked ? .warning : .success
        }
    }
}

/// Shows the latest notice at the top of a screen. Sheets cover the screen
/// beneath them, so each sheet that can stay open adds this too.
struct BannerOverlay: ViewModifier {
    @Environment(AppStore.self) private var store

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let banner = store.banner {
                    BannerView(banner: banner)
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.spring(duration: 0.45), value: store.banner)
    }
}

extension View {
    func showsBanner() -> some View { modifier(BannerOverlay()) }
}

/// The notice that drops in when a shopper pays or is blocked.
struct BannerView: View {
    let banner: Banner

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: banner.blocked ? "hand.raised.fill" : "checkmark.circle.fill")
                .font(.system(size: 22))
                .foregroundStyle(banner.blocked ? Color.blocked : Color.trusted)
            VStack(alignment: .leading, spacing: 1) {
                Text(banner.title)
                    .font(.system(size: 15, weight: .semibold))
                Text(banner.detail)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
            .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .frame(height: 64)
        .glassEffect(.regular, in: .capsule)
        .accessibilityElement(children: .combine)
    }
}
