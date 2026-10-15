import Foundation
import Vision
let request=VNDetectBarcodesRequest()
request.symbologies=[.qr]
let handler=VNImageRequestHandler(url:URL(fileURLWithPath:CommandLine.arguments[1]))
try handler.perform([request])
let values=(request.results ?? []).compactMap{$0.payloadStringValue}
print(values)
guard values == ["https://www.junwei.cool/"] else { fatalError("QR payload mismatch") }
