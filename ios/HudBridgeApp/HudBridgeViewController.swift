import UIKit
import WebKit
import Network
import CoreTelephony

final class HudBridgeViewController: UIViewController, WKScriptMessageHandler {
    private var webView: WKWebView!
    private let pathMonitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "hud.network.monitor")
    private var currentPath: NWPath?
    private var pushTimer: Timer?
    private let telephony = CTTelephonyNetworkInfo()

    private let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "hh:mm a"
        return formatter
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupWebView()
        startBatteryMonitoring()
        startNetworkMonitoring()
        loadHud()
        startPushLoop()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        pathMonitor.cancel()
        pushTimer?.invalidate()
    }

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(self, name: "hudBridge")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        self.webView = webView
    }

    private func loadHud() {
        guard let url = URL(string: "https://ar-walking-hud-sample.npmnorth.workers.dev/?mode=native") else { return }
        webView.load(URLRequest(url: url))
    }

    private func startBatteryMonitoring() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(batteryDidChange),
            name: UIDevice.batteryLevelDidChangeNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(batteryDidChange),
            name: UIDevice.batteryStateDidChangeNotification,
            object: nil
        )
    }

    private func startNetworkMonitoring() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            self?.currentPath = path
            self?.pushStatusToWeb()
        }
        pathMonitor.start(queue: monitorQueue)
    }

    private func startPushLoop() {
        pushTimer?.invalidate()
        pushTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pushStatusToWeb()
        }
    }

    @objc private func batteryDidChange() {
        pushStatusToWeb()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "hudBridge" else { return }
        pushStatusToWeb()
    }

    private func pushStatusToWeb() {
        guard webView != nil else { return }
        let payload = makePayloadObjectLiteral()
        let js = """
        if (window.HUDNativeBridge) {
          window.HUDNativeBridge.setMode('native');
          window.HUDNativeBridge.update(\(payload));
        }
        """

        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func makePayloadObjectLiteral() -> String {
        let batteryLevel = UIDevice.current.batteryLevel
        let batteryPct: String
        if batteryLevel >= 0 {
            batteryPct = String(Int(round(Double(batteryLevel) * 100.0)))
        } else {
            batteryPct = "null"
        }

        let batteryState = UIDevice.current.batteryState
        let isCharging = (batteryState == .charging || batteryState == .full) ? "true" : "false"

        let networkType = jsString(currentNetworkType())
        let carrier = jsString(currentCarrierName())
        let timeText = jsString(timeFormatter.string(from: Date()))

        return "{batteryPct: \(batteryPct), isCharging: \(isCharging), networkType: \(networkType), signalBars: null, carrier: \(carrier), timeText: \(timeText)}"
    }

    private func currentCarrierName() -> String {
        if let providers = telephony.serviceSubscriberCellularProviders {
            return providers.values.first?.carrierName ?? ""
        }
        return ""
    }

    private func currentNetworkType() -> String {
        guard let path = currentPath else {
            return "--"
        }
        guard path.status == .satisfied else {
            return "Offline"
        }

        if path.usesInterfaceType(.wifi) {
            return "WiFi"
        }
        if path.usesInterfaceType(.wiredEthernet) {
            return "Ethernet"
        }
        if path.usesInterfaceType(.cellular) {
            return currentCellularGeneration() ?? "Cellular"
        }
        return "Online"
    }

    private func currentCellularGeneration() -> String? {
        guard let services = telephony.serviceCurrentRadioAccessTechnology,
              let tech = services.values.first else {
            return nil
        }

        let g2: Set<String> = [
            CTRadioAccessTechnologyGPRS,
            CTRadioAccessTechnologyEdge,
            CTRadioAccessTechnologyCDMA1x
        ]
        let g3: Set<String> = [
            CTRadioAccessTechnologyWCDMA,
            CTRadioAccessTechnologyHSDPA,
            CTRadioAccessTechnologyHSUPA,
            CTRadioAccessTechnologyCDMAEVDORev0,
            CTRadioAccessTechnologyCDMAEVDORevA,
            CTRadioAccessTechnologyCDMAEVDORevB,
            CTRadioAccessTechnologyeHRPD
        ]
        let g4: Set<String> = [
            CTRadioAccessTechnologyLTE
        ]
        let g5: Set<String> = [
            "CTRadioAccessTechnologyNR",
            "CTRadioAccessTechnologyNRNSA"
        ]

        if g5.contains(tech) { return "5G" }
        if g4.contains(tech) { return "4G" }
        if g3.contains(tech) { return "3G" }
        if g2.contains(tech) { return "2G" }
        return "Cellular"
    }

    private func jsString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
        return "\"\(escaped)\""
    }
}
