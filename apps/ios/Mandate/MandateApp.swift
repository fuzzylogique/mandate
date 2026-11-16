// Mandate for iPhone: see what your mandates spend, and decide what they may.
import SwiftUI

@main
struct MandateApp: App {
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .preferredColorScheme(.dark)
                .tint(.white)
                .task { store.start() }
        }
    }
}

enum AppTab: Hashable {
    case home, mandates, activity, you
}

struct RootView: View {
    @Environment(AppStore.self) private var store
    @State private var tab: AppTab = .home

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                HomeView(tab: $tab)
            }
            Tab("Mandates", systemImage: "person.2", value: AppTab.mandates) {
                MandatesView()
            }
            Tab("Activity", systemImage: "list.bullet", value: AppTab.activity) {
                ActivityView()
            }
            Tab("You", systemImage: "person.crop.circle", value: AppTab.you) {
                YouView()
            }
        }
        .sheet(isPresented: Binding(get: { store.requiresSignIn }, set: { _ in })) { AccountSignInView().interactiveDismissDisabled() }
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

/// The notice that drops in when a mandate pays or is blocked.
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
