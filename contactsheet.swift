#!/usr/bin/env swift

// Contact sheet generator for PDF files.
// Renders all pages as thumbnails and outputs an HTML file with embedded
// base64 PNG images, making the result scrollable in QuickLook.
// Usage: contactsheet <input.pdf> <output.html> [columns] [thumb_width]

import Foundation
import CoreGraphics
import ImageIO

guard CommandLine.arguments.count >= 3 else {
    fputs("Usage: contactsheet <input.pdf> <output.html> [columns] [thumb_width]\n", stderr)
    exit(1)
}

let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let columns = CommandLine.arguments.count > 3 ? Int(CommandLine.arguments[3]) ?? 5 : 5
let thumbWidth = CommandLine.arguments.count > 4 ? Int(CommandLine.arguments[4]) ?? 200 : 200

guard let pdfURL = CFURLCreateWithFileSystemPath(nil, inputPath as CFString, .cfurlposixPathStyle, false),
      let pdf = CGPDFDocument(pdfURL) else {
    fputs("Error: Cannot open PDF: \(inputPath)\n", stderr)
    exit(1)
}

let pageCount = pdf.numberOfPages
guard pageCount > 0 else {
    fputs("Error: PDF has no pages\n", stderr)
    exit(1)
}

// Render each page as a PNG and encode as base64
func renderPage(_ pageNum: Int, width: Int) -> String? {
    guard let page = pdf.page(at: pageNum) else { return nil }
    let box = page.getBoxRect(.mediaBox)
    let scale = CGFloat(width) / box.width
    let height = Int(box.height * scale)

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    // White background
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

    // Render PDF page
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -box.origin.x, y: -box.origin.y)
    ctx.drawPDFPage(page)

    guard let image = ctx.makeImage() else { return nil }

    // Encode as PNG in memory
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { return nil }

    return (data as Data).base64EncodedString()
}

// Build HTML
var html = """
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Contact Sheet</title>
<style>
body {
    background: #f0f0f0;
    margin: 0;
    padding: 12px;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}
.grid {
    display: grid;
    grid-template-columns: repeat(\(columns), 1fr);
    gap: 12px;
}
.page {
    background: white;
    box-shadow: 0 1px 4px rgba(0,0,0,0.2);
    text-align: center;
    overflow: hidden;
}
.page img {
    width: 100%;
    display: block;
}
.page .label {
    font-size: 11px;
    color: #666;
    padding: 4px 0;
}
</style>
</head>
<body>
<div class="grid">

"""

for i in 1...pageCount {
    if let b64 = renderPage(i, width: thumbWidth * 2) {
        html += """
        <div class="page">
        <img src="data:image/png;base64,\(b64)">
        <div class="label">\(i)</div>
        </div>\n
        """
    }
}

html += """
</div>
</body>
</html>
"""

do {
    try html.write(toFile: outputPath, atomically: true, encoding: .utf8)
} catch {
    fputs("Error: Cannot write output: \(error)\n", stderr)
    exit(1)
}
