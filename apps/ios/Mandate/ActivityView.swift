// Everything your shoppers did with your money: what they paid, and what was blocked.
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
                    Text("Purchases your shoppers make will show up here, each with its receipt.")
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
        .sheet(item: $openReceipt) { ReceiptView(item: $0) }
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundStyle(Color.soft)
            .padding(.top, 6)
    }
}
