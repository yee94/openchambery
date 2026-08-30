import Capacitor
import PhotosUI
import UniformTypeIdentifiers
import UIKit

@objc(OpenChamberComposerPlugin)
class OpenChamberComposerPlugin: CAPPlugin, CAPBridgedPlugin, OpenChamberComposerViewDelegate {
    let identifier = "OpenChamberComposerPlugin"
    let jsName = "OpenChamberComposer"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSuppressed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "focus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "blur", returnType: CAPPluginReturnPromise),
    ]

    private weak var composerView: OpenChamberComposerView?
    private var leadingConstraint: NSLayoutConstraint?
    private var trailingConstraint: NSLayoutConstraint?
    private var bottomConstraint: NSLayoutConstraint?
    private var lastReportedHeight: CGFloat = -1
    private var lastRestHeight: CGFloat = -1
    private var keyboardSessionOpen = false
    private var keyboardObservers: [NSObjectProtocol] = []
    private var hostTapRecognizer: UITapGestureRecognizer?
    private var pickerDelegate: ComposerDocumentPickerDelegate?
    private var photoPickerDelegate: ComposerPhotoPickerDelegate?
    private var attachPhotosLabel = ""
    private var attachFilesLabel = ""
    private static let maxPickedFileBytes = 32 * 1024 * 1024
    private static let maxPickedPhotoCount = 20
    private var lastPreviewSignature = ""
    private var lastModelIcon = ""

    @objc func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("OpenChamberComposer plugin deallocated")
                return
            }
            guard self.installIfNeeded() else {
                call.reject("OpenChamberComposer host view unavailable")
                return
            }
            self.apply(call)
            if call.getBool("suppressed") != true {
                self.composerView?.isHidden = false
            }
            self.reportHeight()
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("OpenChamberComposer plugin deallocated")
                return
            }
            guard self.composerView != nil || self.installIfNeeded() else {
                call.reject("OpenChamberComposer host view unavailable")
                return
            }
            self.apply(call)
            self.reportHeight()
            call.resolve()
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.composerView?.isHidden = true
            call.resolve()
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            self.composerView?.isHidden = false
            self.reportHeight()
            call.resolve()
        }
    }

    @objc func dismiss(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.hideOverlay()
            call.resolve()
        }
    }

    @objc func setSuppressed(_ call: CAPPluginCall) {
        let suppressed = call.getBool("suppressed") ?? false
        DispatchQueue.main.async { [weak self] in
            self?.composerView?.setSuppressed(suppressed)
            self?.reportHeight()
            call.resolve()
        }
    }

    @objc func focus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.composerView?.focusInput()
            call.resolve()
        }
    }

    @objc func blur(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.composerView?.blurInput()
            call.resolve()
        }
    }

    func composerViewDidChangeText(
        _ view: OpenChamberComposerView,
        text: String,
        selectionStart: Int,
        selectionEnd: Int
    ) {
        notifyListeners("textChanged", data: [
            "text": text,
            "composing": view.isComposing,
            "selectionStart": selectionStart,
            "selectionEnd": selectionEnd,
        ])
    }

    func composerViewDidRequestSend(_ view: OpenChamberComposerView, text: String) {
        // Leave the tap / Return handler before crossing to JS so a Web
        // submit cannot deadlock the main queue on plugin.update.
        let payload: [String: Any] = ["text": text]
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("send", data: payload)
        }
    }

    func composerViewDidRequestAbort(_ view: OpenChamberComposerView) {
        notifyListeners("abort", data: [:])
    }

    func composerViewDidRequestAttachPhotos(_ view: OpenChamberComposerView) {
        notifyListeners("attach", data: [:])
        presentPhotoPicker()
    }

    func composerViewDidRequestAttachFiles(_ view: OpenChamberComposerView) {
        notifyListeners("attach", data: [:])
        presentFilePicker()
    }

    func composerViewDidRequestModel(_ view: OpenChamberComposerView) {
        notifyListeners("openModel", data: [:])
    }

    func composerViewDidRequestCycleAgent(_ view: OpenChamberComposerView) {
        notifyListeners("cycleAgent", data: [:])
    }

    func composerViewDidRequestOpenAgent(_ view: OpenChamberComposerView) {
        notifyListeners("openAgent", data: [:])
    }

    func composerViewDidChangeExpanded(_ view: OpenChamberComposerView, expanded: Bool) {
        notifyListeners("expandedChanged", data: ["expanded": expanded])
        reportHeight()
    }

    func composerViewDidChangeHeight(_ view: OpenChamberComposerView) {
        reportHeight()
    }

    func composerViewDidRequestScrollToBottom(_ view: OpenChamberComposerView) {
        notifyListeners("scrollToBottom", data: [:])
    }

    func composerViewDidRequestRemoveAttachment(_ view: OpenChamberComposerView, id: String) {
        notifyListeners("removeAttachment", data: ["id": id])
    }

    func composerViewDidRequestAutocompleteAccept(_ view: OpenChamberComposerView, index: Int) {
        notifyListeners("autocompleteAccept", data: ["index": index])
    }

    func composerViewDidRequestAutocompleteDismiss(_ view: OpenChamberComposerView) {
        notifyListeners("autocompleteDismiss", data: [:])
    }

    @discardableResult
    private func installIfNeeded() -> Bool {
        if composerView != nil { return true }
        guard let host = bridge?.viewController?.view else { return false }
        let composer = OpenChamberComposerView()
        composer.delegate = self
        host.addSubview(composer)

        let leading = composer.leadingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.leadingAnchor, constant: 12)
        let trailing = composer.trailingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.trailingAnchor, constant: -12)
        // One host.bottom pin. Hide events close keyboardSessionOpen so a later
        // changeFrame with a leftover on-screen end-frame cannot raise it again.
        // Rest uses the window home-indicator inset, not view.safeArea (keyboard
        // can contaminate that inset). Keep in sync with
        // contracts/native-composer-keyboard.mjs.
        let bottom = composer.bottomAnchor.constraint(
            equalTo: host.bottomAnchor,
            constant: -Self.restGap(in: host)
        )
        NSLayoutConstraint.activate([leading, trailing, bottom])
        leadingConstraint = leading
        trailingConstraint = trailing
        bottomConstraint = bottom
        composerView = composer
        observeKeyboard()
        installHostDismissTap(on: host)
        return true
    }

    private func apply(_ call: CAPPluginCall) {
        composerView?.applyState(
            text: call.getString("text"),
            placeholder: call.getString("placeholder"),
            modelLabel: call.getString("modelLabel"),
            modelVariantLabel: call.getString("modelVariantLabel"),
            canSend: Self.optionalBool(call, "canSend"),
            canAbort: Self.optionalBool(call, "canAbort"),
            attachmentCount: Self.optionalInt(call, "attachmentCount"),
            appearance: call.getString("appearance"),
            attachAria: call.getString("attachAria"),
            sendAria: call.getString("sendAria"),
            queueAria: call.getString("queueAria"),
            stopAria: call.getString("stopAria"),
            modelAria: call.getString("modelAria"),
            modelIcon: {
                guard let icon = call.getString("modelIcon") else { return nil }
                if icon == lastModelIcon { return nil }
                lastModelIcon = icon
                return icon
            }(),
            agentAria: call.getString("agentAria"),
            agentLabel: call.getString("agentLabel"),
            agentColor: call.getString("agentColor"),
            agentIdenticon: Self.parseIdenticon(call.getArray("agentIdenticon")),
            showScrollToBottom: Self.optionalBool(call, "showScrollToBottom"),
            scrollAria: call.getString("scrollAria"),
            forceText: call.getBool("forceText") ?? false,
            caret: Self.optionalInt(call, "caret")
        )
        if let previews = call.getArray("attachmentPreviews") {
            let signature = Self.previewSignature(previews)
            if signature != lastPreviewSignature {
                lastPreviewSignature = signature
                composerView?.applyAttachmentPreviews(Self.parseAttachmentPreviews(previews))
            }
        }
        if let ranges = call.getArray("citationRanges") {
            composerView?.applyCitationRanges(Self.parseCitationRanges(ranges))
        }
        // Chrome-only updates omit chipRanges. Re-painting here walks
        // textStorage and UITextPosition on every canSend/scroll tick.
        if let ranges = call.getArray("chipRanges") {
            composerView?.applyChipRanges(parseChipRanges(ranges))
        }
        if let autocomplete = call.getObject("autocomplete") {
            composerView?.applyAutocomplete(Self.parseAutocomplete(autocomplete))
        }
        if let photos = call.getString("attachPhotosLabel"), !photos.isEmpty {
            attachPhotosLabel = photos
        }
        if let files = call.getString("attachFilesLabel"), !files.isEmpty {
            attachFilesLabel = files
        }
        composerView?.setAttachChooser(photos: attachPhotosLabel, files: attachFilesLabel)
        if let suppressed = call.getBool("suppressed") {
            composerView?.setSuppressed(suppressed)
        }
    }

    /// Hide the process-owned overlay. ChatInput remounts on phone page
    /// switches; tearing the UITextView / glass view down would rebuild it
    /// every time. `present` reuses `installIfNeeded`.
    /// Visual hide is first so leaving chat does not wait on blur / keyboard.
    private func hideOverlay() {
        composerView?.isHidden = true
        dismissFilePicker()
        composerView?.setKeepExpandedThroughPicker(false)
        composerView?.blurInput()
        composerView?.handleKeyboardDidHide()
        keyboardSessionOpen = false
        if let host = composerView?.superview {
            bottomConstraint?.constant = -Self.restGap(in: host)
        }
        lastReportedHeight = -1
        notifyListeners("heightChanged", data: ["height": 0])
    }

    private func installHostDismissTap(on host: UIView) {
        removeHostDismissTap()
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleHostTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        host.addGestureRecognizer(tap)
        hostTapRecognizer = tap
    }

    private func removeHostDismissTap() {
        if let tap = hostTapRecognizer {
            tap.view?.removeGestureRecognizer(tap)
        }
        hostTapRecognizer = nil
    }

    @objc private func handleHostTap(_ recognizer: UITapGestureRecognizer) {
        guard let composer = composerView, !composer.isHidden, let host = composer.superview else { return }
        let point = recognizer.location(in: host)
        if composer.containsTouch(at: point, in: host) { return }
        composer.blurInput()
    }

    private func observeKeyboard() {
        stopObservingKeyboard()
        let names: [Notification.Name] = [
            UIResponder.keyboardWillChangeFrameNotification,
            UIResponder.keyboardWillHideNotification,
            UIResponder.keyboardWillShowNotification,
            UIResponder.keyboardDidChangeFrameNotification,
            UIResponder.keyboardDidHideNotification,
            UIResponder.keyboardDidShowNotification,
        ]
        for name in names {
            let token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                self?.applyKeyboard(notification)
            }
            keyboardObservers.append(token)
        }
    }

    private func applyKeyboard(_ notification: Notification) {
        guard let composer = composerView, let host = composer.superview, !composer.isHidden else {
            reportHeight()
            return
        }
        let event = Self.keyboardEventName(notification.name)
        if event == "willHide" || event == "didHide" {
            composer.dismissAttachMenu()
        }
        keyboardSessionOpen = Self.nextSession(open: keyboardSessionOpen, event: event)
        let overlap = Self.keyboardOverlap(endFrame: notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect, host: host)
        let gap = Self.bottomGap(
            sessionOpen: keyboardSessionOpen,
            overlap: overlap,
            windowSafeBottom: host.window?.safeAreaInsets.bottom ?? host.safeAreaInsets.bottom
        )
        let duration = (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
        let curveRaw = (notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.intValue
            ?? UIView.AnimationCurve.easeInOut.rawValue
        let options = UIView.AnimationOptions(rawValue: UInt(curveRaw << 16)).union(.beginFromCurrentState)

        let apply = {
            self.bottomConstraint?.constant = -gap
            host.layoutIfNeeded()
        }
        let finish = {
            self.reportHeight()
            if (event == "willHide" || event == "didHide"),
               self.composerView?.keepExpandedThroughPicker != true {
                self.composerView?.handleKeyboardDidHide()
            }
        }
        if duration > 0 {
            UIView.animate(withDuration: duration, delay: 0, options: options, animations: apply) { _ in
                finish()
            }
        } else {
            apply()
            finish()
        }
    }

    private static func keyboardEventName(_ name: Notification.Name) -> String {
        switch name {
        case UIResponder.keyboardWillShowNotification: return "willShow"
        case UIResponder.keyboardDidShowNotification: return "didShow"
        case UIResponder.keyboardWillHideNotification: return "willHide"
        case UIResponder.keyboardDidHideNotification: return "didHide"
        case UIResponder.keyboardWillChangeFrameNotification: return "willChangeFrame"
        case UIResponder.keyboardDidChangeFrameNotification: return "didChangeFrame"
        default: return "didChangeFrame"
        }
    }

    private static func nextSession(open: Bool, event: String) -> Bool {
        if event == "willShow" || event == "didShow" { return true }
        if event == "willHide" || event == "didHide" { return false }
        return open
    }

    private static func bottomGap(sessionOpen: Bool, overlap: CGFloat, windowSafeBottom: CGFloat) -> CGFloat {
        if !sessionOpen { return max(0, windowSafeBottom) + 12 }
        if overlap > 1 { return overlap + 12 }
        return max(0, windowSafeBottom) + 12
    }

    private static func restGap(in host: UIView) -> CGFloat {
        bottomGap(sessionOpen: false, overlap: 0, windowSafeBottom: host.window?.safeAreaInsets.bottom ?? host.safeAreaInsets.bottom)
    }

    private static func keyboardOverlap(endFrame: CGRect?, host: UIView) -> CGFloat {
        guard let endFrame else { return 0 }
        if let window = host.window {
            let keyboardInWindow = window.convert(endFrame, from: nil)
            let hostInWindow = host.convert(host.bounds, to: window)
            return max(0, hostInWindow.maxY - keyboardInWindow.minY)
        }
        let converted = host.convert(endFrame, from: nil)
        return max(0, host.bounds.maxY - converted.minY)
    }

    private func stopObservingKeyboard() {
        for token in keyboardObservers {
            NotificationCenter.default.removeObserver(token)
        }
        keyboardObservers = []
    }

    private func reportHeight() {
        guard let composer = composerView, let host = composer.superview, !composer.isHidden else {
            if lastReportedHeight != 0 {
                lastReportedHeight = 0
                notifyListeners("heightChanged", data: ["height": 0])
            }
            return
        }
        host.layoutIfNeeded()
        // Collapsed occupancy only (pill + rest gap). The scroll button does
        // not change this value, so accessories do not jump when it appears.
        // Keep the last rest value while expanded so queue/changes/todos stay put.
        let occupancy = max(0, host.bounds.maxY - composer.restTop(in: host))
        let rounded = (occupancy * 100).rounded() / 100
        if !composer.isExpandedState {
            lastRestHeight = rounded
        }
        let published = lastRestHeight >= 0 ? lastRestHeight : rounded
        guard abs(published - lastReportedHeight) > 0.5 else { return }
        lastReportedHeight = published
        notifyListeners("heightChanged", data: ["height": published])
    }

    private func beginAttachPicker() {
        composerView?.setKeepExpandedThroughPicker(true)
    }

    private func endAttachPicker(restoreFocus: Bool) {
        composerView?.setKeepExpandedThroughPicker(false)
        if restoreFocus {
            composerView?.focusInput()
        }
    }

    private func presentPhotoPicker() {
        guard let host = bridge?.viewController else { return }
        if host.presentedViewController != nil { return }
        beginAttachPicker()
        var configuration = PHPickerConfiguration()
        configuration.selectionLimit = Self.maxPickedPhotoCount
        configuration.filter = .images
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        let delegate = ComposerPhotoPickerDelegate { [weak self] results in
            self?.photoPickerDelegate = nil
            self?.endAttachPicker(restoreFocus: true)
            self?.emitPickedPhotos(results)
        }
        picker.delegate = delegate
        photoPickerDelegate = delegate
        host.present(picker, animated: true)
    }

    private func presentFilePicker() {
        guard let host = bridge?.viewController else { return }
        if host.presentedViewController != nil { return }
        beginAttachPicker()
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.item], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.shouldShowFileExtensions = true
        let delegate = ComposerDocumentPickerDelegate { [weak self] urls in
            self?.pickerDelegate = nil
            self?.endAttachPicker(restoreFocus: true)
            self?.emitPickedFiles(urls)
        }
        picker.delegate = delegate
        pickerDelegate = delegate
        host.present(picker, animated: true)
    }

    private func dismissFilePicker() {
        pickerDelegate = nil
        photoPickerDelegate = nil
        guard let presented = bridge?.viewController?.presentedViewController else { return }
        if presented is UIDocumentPickerViewController
            || presented is PHPickerViewController {
            presented.dismiss(animated: false)
        }
        endAttachPicker(restoreFocus: false)
    }

    private func emitPickedFiles(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var files: [[String: String]] = []
            var skipped: [[String: String]] = []
            for url in urls {
                let accessed = url.startAccessingSecurityScopedResource()
                defer {
                    if accessed { url.stopAccessingSecurityScopedResource() }
                }
                let name = url.lastPathComponent
                guard let data = try? Data(contentsOf: url) else {
                    skipped.append(["name": name, "reason": "unreadable"])
                    continue
                }
                if data.count > Self.maxPickedFileBytes {
                    skipped.append(["name": name, "reason": "tooLarge"])
                    continue
                }
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                    ?? "application/octet-stream"
                files.append([
                    "name": name,
                    "mime": mime,
                    "dataBase64": data.base64EncodedString(),
                ])
            }
            guard !files.isEmpty || !skipped.isEmpty else { return }
            DispatchQueue.main.async {
                self?.notifyListeners("filesPicked", data: [
                    "files": files,
                    "skipped": skipped,
                ])
            }
        }
    }

    private func emitPickedPhotos(_ results: [PHPickerResult]) {
        guard !results.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let group = DispatchGroup()
            let lock = NSLock()
            var files: [[String: String]] = []
            var skipped: [[String: String]] = []
            for (index, result) in results.enumerated() {
                let provider = result.itemProvider
                let typeIdentifier = provider.registeredTypeIdentifiers.first(where: { identifier in
                    UTType(identifier)?.conforms(to: .image) == true
                }) ?? UTType.image.identifier
                group.enter()
                provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                    defer { group.leave() }
                    let suggested = provider.suggestedName ?? "photo-\(index + 1)"
                    let name = suggested.contains(".") ? suggested : "\(suggested).jpg"
                    guard let data else {
                        lock.lock()
                        skipped.append(["name": name, "reason": "unreadable"])
                        lock.unlock()
                        return
                    }
                    if data.count > Self.maxPickedFileBytes {
                        lock.lock()
                        skipped.append(["name": name, "reason": "tooLarge"])
                        lock.unlock()
                        return
                    }
                    let mime = UTType(typeIdentifier)?.preferredMIMEType ?? "image/jpeg"
                    lock.lock()
                    files.append([
                        "name": name,
                        "mime": mime,
                        "dataBase64": data.base64EncodedString(),
                    ])
                    lock.unlock()
                }
            }
            group.wait()
            guard !files.isEmpty || !skipped.isEmpty else { return }
            DispatchQueue.main.async {
                self?.notifyListeners("filesPicked", data: [
                    "files": files,
                    "skipped": skipped,
                ])
            }
        }
    }

    /// Capacitor's one-arg `getBool`/`getInt` default missing keys to false/0.
    /// Slim chrome updates omit those keys and must not clobber live state.
    private static func optionalBool(_ call: CAPPluginCall, _ key: String) -> Bool? {
        guard call.hasOption(key) else { return nil }
        return call.getBool(key)
    }

    private static func optionalInt(_ call: CAPPluginCall, _ key: String) -> Int? {
        guard call.hasOption(key) else { return nil }
        return call.getInt(key)
    }

    private static func jsString(_ object: JSObject, _ key: String) -> String {
        if let value = object[key] as? String { return value }
        if let value = object[key] as? NSString { return value as String }
        return ""
    }

    private static func previewSignature(_ raw: JSArray) -> String {
        raw.compactMap { entry -> String? in
            guard let object = entry as? JSObject else { return nil }
            guard let id = object["id"] as? String, !id.isEmpty else { return nil }
            let filename = object["filename"] as? String ?? ""
            let mime = object["mime"] as? String ?? ""
            let thumb = (object["thumbnailBase64"] as? String)?.count ?? 0
            return "\(id):\(filename):\(mime):\(thumb)"
        }.joined(separator: "|")
    }

    private static func parseAttachmentPreviews(_ raw: JSArray) -> [AttachmentPreviewItem] {
        raw.compactMap { entry -> AttachmentPreviewItem? in
            guard let object = entry as? JSObject else { return nil }
            guard let id = object["id"] as? String, !id.isEmpty else { return nil }
            let filename = object["filename"] as? String ?? "file"
            let mime = object["mime"] as? String ?? ""
            let removeAria = object["removeAria"] as? String ?? ""
            let thumbnail = (object["thumbnailBase64"] as? String).flatMap { OpenChamberComposerView.decodePreviewImage($0) }
            return AttachmentPreviewItem(
                id: id,
                filename: filename,
                mime: mime,
                thumbnail: thumbnail,
                removeAria: removeAria
            )
        }
    }

    private static func parseAutocomplete(_ raw: JSObject) -> ComposerAutocompleteState {
        let open = (raw["open"] as? Bool) ?? false
        let highlighted = (raw["highlightedIndex"] as? NSNumber)?.intValue
            ?? (raw["highlightedIndex"] as? Int)
            ?? 0
        let rows = (raw["rows"] as? JSArray)?.compactMap { entry -> ComposerAutocompleteRow? in
            guard let object = entry as? JSObject else { return nil }
            guard let id = object["id"] as? String, !id.isEmpty else { return nil }
            let title = Self.jsString(object, "title")
            let subtitle = Self.jsString(object, "subtitle")
            let badge = Self.jsString(object, "badge")
            let icon = (object["iconBase64"] as? String).flatMap { OpenChamberComposerView.decodePreviewImage($0) }
            return ComposerAutocompleteRow(id: id, title: title, subtitle: subtitle, badge: badge, icon: icon)
        } ?? []
        return ComposerAutocompleteState(open: open, highlightedIndex: highlighted, rows: rows)
    }

    private static func parseCitationRanges(_ raw: JSArray) -> [NSRange] {
        raw.compactMap { entry -> NSRange? in
            guard let object = entry as? JSObject else { return nil }
            let startValue = object["start"]
            let endValue = object["end"]
            let start = (startValue as? NSNumber)?.intValue ?? (startValue as? Int)
            let end = (endValue as? NSNumber)?.intValue ?? (endValue as? Int)
            guard let start, let end, start >= 0, end >= start else { return nil }
            return NSRange(location: start, length: end - start)
        }
    }

    private func parseChipRanges(_ raw: JSArray) -> [ComposerChip] {
        raw.compactMap { entry -> ComposerChip? in
            guard let object = entry as? JSObject else { return nil }
            let startValue = object["start"]
            let endValue = object["end"]
            let triggerValue = object["triggerLength"]
            let start = (startValue as? NSNumber)?.intValue ?? (startValue as? Int)
            let end = (endValue as? NSNumber)?.intValue ?? (endValue as? Int)
            let triggerLength = (triggerValue as? NSNumber)?.intValue ?? (triggerValue as? Int)
            guard let start, let end, let triggerLength, start >= 0, end > start, triggerLength >= 1, start + triggerLength <= end else {
                return nil
            }
            let color = OpenChamberComposerView.parseColor(Self.jsString(object, "color"))
            return ComposerChip(
                range: NSRange(location: start, length: end - start),
                triggerLength: triggerLength,
                color: color
            )
        }
    }

    private static func parseIdenticon(_ raw: [Any]?) -> [Int]? {
        guard let values = raw else { return nil }
        let bits = values.compactMap { value -> Int? in
            if let number = value as? NSNumber { return number.intValue == 0 ? 0 : 1 }
            if let number = value as? Int { return number == 0 ? 0 : 1 }
            return nil
        }
        return bits.count == 25 ? bits : nil
    }
}

private final class ComposerDocumentPickerDelegate: NSObject, UIDocumentPickerDelegate {
    private let onPick: ([URL]) -> Void

    init(onPick: @escaping ([URL]) -> Void) {
        self.onPick = onPick
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        onPick(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        onPick([])
    }
}

private final class ComposerPhotoPickerDelegate: NSObject, PHPickerViewControllerDelegate {
    private let onPick: ([PHPickerResult]) -> Void

    init(onPick: @escaping ([PHPickerResult]) -> Void) {
        self.onPick = onPick
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) { [onPick] in
            onPick(results)
        }
    }
}

extension OpenChamberComposerPlugin: UIGestureRecognizerDelegate {
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}
