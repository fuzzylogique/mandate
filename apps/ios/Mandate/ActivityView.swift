// Everything that happened to your money: what shoppers paid, what was blocked, and money added.
import SwiftUI

struct ActivityView: View {
    @Environment(AppStore.self) private var store
    @State private var openReceipt: Activity?

    var body: some View {
        let today = store.activity.filter { Calendar.current.isDateInToday($0.date) }
        let earlier = store.activity.filter { !Calendar.current.isDateInToday($0.date) }

        Screen {
            VStack(alignment: .leading, spacing: 12) {
                Text("Activity")
                    .font(.system(size: 30, weight: .semibold))
                    .tracking(-0.8)
                    .frame(height: 44)
                    .padding(.top, 8)

                if store.activity.isEmpty {
                    Text("Purchases, blocked payments and money you add show up here, each with its receipt.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.soft)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassPanel()
                }
                if !today.isEmpty {
                    heading("Today")
                    ActivityPanel(items: today) { openReceipt = $0 }
                }
                if !earlier.isEmpty {
                    heading("Earlier")
                    ActivityPanel(items: earlier) { openReceipt = $0 }
                }
            }
        }
        // Before the sheets, so pull-to-refresh does not leak into them.
        .refreshable { await store.refresh() }
        .sheet(item: $openReceipt) { ReceiptView(item: $0) }
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundStyle(Color.soft)
            .padding(.top, 6)
    }
}
