import { readFile, writeFile } from "node:fs/promises";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  TextRun
} from "docx";

const inputPath = new URL("../docs/adf-testimonial-generator-implementation-guide.md", import.meta.url);
const outputPath = new URL("../docs/adf-testimonial-generator-implementation-guide.docx", import.meta.url);

const markdown = await readFile(inputPath, "utf8");
const children = markdownToDocxParagraphs(markdown);

const document = new Document({
  creator: "Cursor Agent",
  description:
    "End-to-end implementation guide for the private AWS ADF testimonial generator.",
  sections: [
    {
      children,
      properties: {
        page: {
          margin: {
            bottom: 720,
            left: 720,
            right: 720,
            top: 720
          }
        }
      }
    }
  ],
  styles: {
    default: {
      document: {
        run: {
          font: "Aptos",
          size: 22
        }
      }
    },
    paragraphStyles: [
      {
        id: "Title",
        name: "Title",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: {
          bold: true,
          color: "17365D",
          font: "Aptos Display",
          size: 40
        },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: {
            after: 300
          }
        }
      },
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: {
          bold: true,
          color: "17365D",
          font: "Aptos Display",
          size: 30
        },
        paragraph: {
          spacing: {
            after: 180,
            before: 360
          }
        }
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: {
          bold: true,
          color: "1F4E79",
          font: "Aptos Display",
          size: 26
        },
        paragraph: {
          spacing: {
            after: 140,
            before: 260
          }
        }
      },
      {
        id: "Heading3",
        name: "Heading 3",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: {
          bold: true,
          color: "2F5597",
          font: "Aptos Display",
          size: 24
        },
        paragraph: {
          spacing: {
            after: 100,
            before: 200
          }
        }
      }
    ]
  },
  title: "ADF Testimonial Generator - End-to-End Implementation Guide"
});

await writeFile(outputPath, await Packer.toBuffer(document));
console.log(`Generated ${outputPath.pathname}`);

function markdownToDocxParagraphs(source) {
  const paragraphs = [];
  const lines = source.split(/\r?\n/);
  let inCodeBlock = false;
  let pendingParagraph = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.startsWith("```")) {
      flushParagraph(paragraphs, pendingParagraph);
      pendingParagraph = [];
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              font: "Courier New",
              size: 19,
              text: line || " "
            })
          ],
          shading: {
            fill: "F3F4F6",
            type: ShadingType.CLEAR
          },
          spacing: {
            after: 40,
            before: 40
          }
        })
      );
      continue;
    }

    if (!line.trim()) {
      flushParagraph(paragraphs, pendingParagraph);
      pendingParagraph = [];
      continue;
    }

    if (line === "---") {
      flushParagraph(paragraphs, pendingParagraph);
      pendingParagraph = [];
      paragraphs.push(
        new Paragraph({
          border: {
            bottom: {
              color: "D9E2F3",
              size: 8,
              style: "single"
            }
          },
          spacing: {
            after: 180,
            before: 180
          }
        })
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph(paragraphs, pendingParagraph);
      pendingParagraph = [];
      const level = headingMatch[1].length;
      paragraphs.push(
        new Paragraph({
          children: parseInlineRuns(headingMatch[2]),
          heading:
            level === 1
              ? HeadingLevel.HEADING_1
              : level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          pageBreakBefore: level === 1 && paragraphs.length > 0
        })
      );
      continue;
    }

    const bulletMatch = line.match(/^\s*-\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph(paragraphs, pendingParagraph);
      pendingParagraph = [];
      paragraphs.push(
        new Paragraph({
          bullet: {
            level: 0
          },
          children: parseInlineRuns(bulletMatch[1]),
          spacing: {
            after: 80
          }
        })
      );
      continue;
    }

    const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph(paragraphs, pendingParagraph);
      pendingParagraph = [];
      paragraphs.push(
        new Paragraph({
          children: parseInlineRuns(`${numberedMatch[1]}. ${numberedMatch[2]}`),
          indent: {
            left: 360
          },
          spacing: {
            after: 80
          }
        })
      );
      continue;
    }

    pendingParagraph.push(line.trim());
  }

  flushParagraph(paragraphs, pendingParagraph);
  return paragraphs;
}

function flushParagraph(paragraphs, pendingParagraph) {
  if (!pendingParagraph.length) {
    return;
  }

  paragraphs.push(
    new Paragraph({
      children: parseInlineRuns(pendingParagraph.join(" ")),
      spacing: {
        after: 140
      }
    })
  );
}

function parseInlineRuns(text) {
  const runs = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      runs.push(new TextRun({ text: text.slice(cursor, match.index) }));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      runs.push(
        new TextRun({
          font: "Courier New",
          shading: {
            fill: "EEF2F7",
            type: ShadingType.CLEAR
          },
          text: token.slice(1, -1)
        })
      );
    } else {
      runs.push(
        new TextRun({
          bold: true,
          text: token.slice(2, -2)
        })
      );
    }

    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    runs.push(new TextRun({ text: text.slice(cursor) }));
  }

  return runs.length ? runs : [new TextRun({ text: "" })];
}
