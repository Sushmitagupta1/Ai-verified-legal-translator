import { describe, expect, it } from "vitest";
import { paragraphsFromHtml, extractFromBuffer } from "../src/lib/pipeline/extract";

/**
 * DOCX paragraph recovery.
 *
 * mammoth emits HTML, and a paragraph's first run is frequently markup: the
 * letterhead name is bold, the report title is bold+underlined, the field labels
 * are list items. Reading "text starts with `<`" as "this is a tag to skip"
 * deleted whole paragraphs — and with them the two lines the report pattern is
 * recognised from, so both exports fell back to a headerless document.
 */
describe("paragraphsFromHtml", () => {
  it("keeps a paragraph that opens with an inline tag", () => {
    const html = "<p><strong>VISHAL M. KOTHARI</strong>   M: 9898266089</p>";
    expect(paragraphsFromHtml(html)).toEqual(["VISHAL M. KOTHARI M: 9898266089"]);
  });

  it("keeps a paragraph that is entirely one inline tag", () => {
    const html = "<p><strong>TITLE CLEARANCE REPORT</strong></p>";
    expect(paragraphsFromHtml(html)).toEqual(["TITLE CLEARANCE REPORT"]);
  });

  it("emits nothing for block tags alone", () => {
    const html = "<p></p><table><tr><td>a</td></tr></table>";
    expect(paragraphsFromHtml(html)).toEqual(["a"]);
  });

  it("splits a list into one paragraph per item", () => {
    const html =
      "<ol><li><strong>Name of the Owner</strong>: </li>" +
      "<li><strong>Constitution of the Owner</strong>: A Limited Liability Partnership firm</li></ol>";
    expect(paragraphsFromHtml(html)).toEqual([
      "Name of the Owner:",
      "Constitution of the Owner: A Limited Liability Partnership firm",
    ]);
  });

  it("treats an explicit page break as a boundary, not content", () => {
    const html = '<p>first</p><p style="page-break-before: always">second</p>';
    expect(paragraphsFromHtml(html)).toEqual(["first", "second"]);
  });

  it("decodes the entities it encounters", () => {
    const html = "<p>A &amp; B &lt;C&gt; &quot;D&quot;</p>";
    expect(paragraphsFromHtml(html)).toEqual(['A & B <C> "D"']);
  });
});

describe("extractFromBuffer (docx)", () => {
  it("recovers bold letterhead and title paragraphs from a real docx", async () => {
    const docx = await import("docx");
    const bold = (text: string) => new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true })] });
    const plain = (text: string) => new docx.Paragraph({ children: [new docx.TextRun({ text })] });

    const doc = new docx.Document({
      sections: [
        {
          children: [
            bold("VISHAL M. KOTHARI"),
            plain("(Advocate)"),
            bold("TITLE CLEARANCE REPORT"),
            plain("To,"),
          ],
        },
      ],
    });
    const buffer = await docx.Packer.toBuffer(doc);

    const result = await extractFromBuffer(
      buffer,
      "letterhead.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const text = result.pages.map((page) => page.text).join("\n");
    expect(text).toContain("VISHAL M. KOTHARI");
    expect(text).toContain("TITLE CLEARANCE REPORT");
    expect(text).toContain("(Advocate)");
    expect(text).toContain("To,");
  });
});
