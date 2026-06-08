#!/usr/bin/env python3
"""
Generates the "Wireless Multicam Studio - Tester Quick-Start" PDF.

Clean, modern, A4, print-friendly: light background, dark text,
green accent (#16a34a), red used only for the REC/program note.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
    Table, TableStyle, KeepTogether, FrameBreak, NextPageTemplate,
    PageBreak, Flowable,
)
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

# ----------------------------------------------------------------------------
# Palette
# ----------------------------------------------------------------------------
GREEN       = HexColor("#16a34a")   # primary accent
GREEN_DARK  = HexColor("#0f7a37")
GREEN_TINT  = HexColor("#eaf7ef")   # callout / tip background
GREEN_LINE  = HexColor("#bfe6cd")   # callout border
RED         = HexColor("#dc2626")   # REC / program only
RED_TINT    = HexColor("#fdeaea")
RED_LINE    = HexColor("#f3bcbc")
INK         = HexColor("#1f2933")   # body text
INK_SOFT    = HexColor("#52606d")   # secondary text
INK_FAINT   = HexColor("#7b8794")   # captions / footer
RULE        = HexColor("#e2e6ea")   # hairlines
PAGE_BG     = HexColor("#ffffff")
CHIP_BG     = HexColor("#f1f5f3")   # inline UI-label chip
CHIP_LINE   = HexColor("#d6e3da")
CHIP_INK    = HexColor("#155e34")

PAGE_W, PAGE_H = A4
MARGIN_X = 20 * mm
MARGIN_TOP = 22 * mm
MARGIN_BOT = 18 * mm

OUTPUT = r"C:/Users/Nicol/OneDrive/Documents/Development/OpenIdle/idle-stream/Wireless-Multicam-Studio-Tester-Guide.pdf"

# ----------------------------------------------------------------------------
# Styles
# ----------------------------------------------------------------------------
ss = getSampleStyleSheet()

BODY_FONT = "Helvetica"
BOLD_FONT = "Helvetica-Bold"
OBLIQUE   = "Helvetica-Oblique"

styles = {}

styles["cover_title"] = ParagraphStyle(
    "cover_title", fontName=BOLD_FONT, fontSize=30, leading=35,
    textColor=INK, spaceAfter=0,
)
styles["cover_sub"] = ParagraphStyle(
    "cover_sub", fontName=BODY_FONT, fontSize=13.5, leading=20,
    textColor=INK_SOFT,
)
styles["cover_eyebrow"] = ParagraphStyle(
    "cover_eyebrow", fontName=BOLD_FONT, fontSize=10, leading=12,
    textColor=GREEN, spaceAfter=0,
)
styles["section"] = ParagraphStyle(
    "section", fontName=BOLD_FONT, fontSize=13, leading=16,
    textColor=GREEN_DARK, spaceBefore=2, spaceAfter=6,
)
styles["step_title"] = ParagraphStyle(
    "step_title", fontName=BOLD_FONT, fontSize=12.5, leading=15,
    textColor=INK,
)
styles["step_kicker"] = ParagraphStyle(
    "step_kicker", fontName=BOLD_FONT, fontSize=8.5, leading=10,
    textColor=GREEN, spaceAfter=2,
)
styles["body"] = ParagraphStyle(
    "body", fontName=BODY_FONT, fontSize=10, leading=14.5,
    textColor=INK, spaceAfter=3.5,
)
styles["bullet"] = ParagraphStyle(
    "bullet", fontName=BODY_FONT, fontSize=10, leading=14.5,
    textColor=INK, leftIndent=12, bulletIndent=2, spaceAfter=4,
)
styles["sub_bullet"] = ParagraphStyle(
    "sub_bullet", fontName=BODY_FONT, fontSize=9.5, leading=14,
    textColor=INK_SOFT, leftIndent=24, bulletIndent=14, spaceAfter=3,
)
styles["substep_label"] = ParagraphStyle(
    "substep_label", fontName=BOLD_FONT, fontSize=10, leading=14.5,
    textColor=GREEN_DARK, spaceAfter=2,
)
styles["callout_title"] = ParagraphStyle(
    "callout_title", fontName=BOLD_FONT, fontSize=9.5, leading=12,
    textColor=GREEN_DARK, spaceAfter=2,
)
styles["callout_body"] = ParagraphStyle(
    "callout_body", fontName=BODY_FONT, fontSize=9.5, leading=13.5,
    textColor=INK, spaceAfter=0,
)
styles["warn_title"] = ParagraphStyle(
    "warn_title", fontName=BOLD_FONT, fontSize=9.5, leading=12,
    textColor=RED, spaceAfter=2,
)
styles["footer"] = ParagraphStyle(
    "footer", fontName=BODY_FONT, fontSize=8, leading=10,
    textColor=INK_FAINT,
)
styles["cover_meta"] = ParagraphStyle(
    "cover_meta", fontName=BODY_FONT, fontSize=9.5, leading=15,
    textColor=INK_SOFT,
)
styles["cover_meta_strong"] = ParagraphStyle(
    "cover_meta_strong", fontName=BOLD_FONT, fontSize=9.5, leading=15,
    textColor=INK,
)


def chip(text):
    """Inline 'UI label' chip — renders the exact menu label as a tinted pill so
    real UI strings stand out from instructional prose."""
    return (
        f'<font face="{BOLD_FONT}" size="9" color="#155e34" backColor="#e7f3ec">'
        f'&nbsp;{text}&nbsp;</font>'
    )


def b(text):
    return f'<b>{text}</b>'


# ----------------------------------------------------------------------------
# Custom flowables
# ----------------------------------------------------------------------------
class HRule(Flowable):
    def __init__(self, width, color=RULE, thickness=0.7, space_before=0, space_after=0):
        super().__init__()
        self.width = width
        self.color = color
        self.thickness = thickness
        self.space_before = space_before
        self.space_after = space_after
        self.height = thickness + space_before + space_after

    def draw(self):
        c = self.canv
        c.setStrokeColor(self.color)
        c.setLineWidth(self.thickness)
        y = self.space_after
        c.line(0, y, self.width, y)

    def wrap(self, aw, ah):
        return (self.width, self.height)


class StepNumber(Flowable):
    """A filled green rounded square with the step number, drawn as a cell."""
    def __init__(self, num, size=9 * mm):
        super().__init__()
        self.num = str(num)
        self.size = size

    def wrap(self, aw, ah):
        return (self.size, self.size)

    def draw(self):
        c = self.canv
        c.setFillColor(GREEN)
        c.roundRect(0, 0, self.size, self.size, 2.2 * mm, stroke=0, fill=1)
        c.setFillColor(white)
        c.setFont(BOLD_FONT, 12)
        c.drawCentredString(self.size / 2.0, self.size / 2.0 - 4.2, self.num)


# ----------------------------------------------------------------------------
# Box builders (callouts / steps) using nested tables for backgrounds
# ----------------------------------------------------------------------------
def callout(title, body_html, kind="tip", width=None):
    """kind: 'tip' (green) or 'warn' (red)."""
    if kind == "warn":
        bg, line, tstyle = RED_TINT, RED_LINE, styles["warn_title"]
        bar = RED
    else:
        bg, line, tstyle = GREEN_TINT, GREEN_LINE, styles["callout_title"]
        bar = GREEN

    inner = []
    if title:
        inner.append(Paragraph(title, tstyle))
    inner.append(Paragraph(body_html, styles["callout_body"]))

    inner_tbl = Table([[i] for i in inner], colWidths=[(width or 0) - 14 * mm])
    inner_tbl.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))

    # color bar + content
    tbl = Table(
        [["", inner_tbl]],
        colWidths=[1.6 * mm, (width or 0) - 1.6 * mm],
    )
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), bar),
        ("BACKGROUND", (1, 0), (1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.7, line),
        ("LINEBEFORE", (1, 0), (1, -1), 0, line),
        ("LEFTPADDING", (1, 0), (1, -1), 5.5 * mm),
        ("RIGHTPADDING", (1, 0), (1, -1), 5 * mm),
        ("TOPPADDING", (1, 0), (1, -1), 4 * mm),
        ("BOTTOMPADDING", (1, 0), (1, -1), 4 * mm),
        ("LEFTPADDING", (0, 0), (0, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, -1), 0),
        ("TOPPADDING", (0, 0), (0, -1), 0),
        ("BOTTOMPADDING", (0, 0), (0, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return tbl


def step_block(num, title, flowables, content_width):
    """A numbered step: green number tile + title, then body content, all kept together."""
    title_p = Paragraph(title, styles["step_title"])

    header = Table(
        [[StepNumber(num), title_p]],
        colWidths=[9 * mm + 4 * mm, content_width - (9 * mm + 4 * mm)],
    )
    header.setStyle(TableStyle([
        ("VALIGN", (0, 0), (0, 0), "MIDDLE"),
        ("VALIGN", (1, 0), (1, 0), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("RIGHTPADDING", (0, 0), (0, 0), 4 * mm),
        ("LEFTPADDING", (1, 0), (1, 0), 0),
        ("RIGHTPADDING", (1, 0), (1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, 0), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 0),
    ]))

    # Body indented to align under the title text (left of the number tile width)
    indent = 9 * mm + 4 * mm
    body_tbl = Table([[f] for f in flowables], colWidths=[content_width - indent])
    body_tbl.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    wrap = Table(
        [[header], ["", ], [Table([["", body_tbl]], colWidths=[indent, content_width - indent])]],
        colWidths=[content_width],
    )
    # The above is fiddly; build more simply below instead.
    return None


# A cleaner step builder
def make_step(num, title, body_flowables, content_width):
    title_p = Paragraph(title, styles["step_title"])
    indent = 13 * mm  # number tile (9mm) + gap (4mm)

    body_tbl = Table([[f] for f in body_flowables],
                     colWidths=[content_width - indent])
    body_tbl.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))

    grid = Table(
        [
            [StepNumber(num), title_p],
            ["", body_tbl],
        ],
        colWidths=[indent, content_width - indent],
    )
    grid.setStyle(TableStyle([
        ("SPAN", (0, 0), (0, 0)),
        ("VALIGN", (0, 0), (0, 0), "MIDDLE"),
        ("VALIGN", (1, 0), (1, 0), "MIDDLE"),
        ("VALIGN", (1, 1), (1, 1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, -1), 4 * mm),
        ("RIGHTPADDING", (1, 0), (1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, 0), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("TOPPADDING", (0, 1), (-1, 1), 0),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 0),
    ]))
    return KeepTogether([grid, Spacer(1, 4.5 * mm)])


# ----------------------------------------------------------------------------
# Page chrome
# ----------------------------------------------------------------------------
def draw_bg(c):
    c.setFillColor(PAGE_BG)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)


def cover_page(c, doc):
    draw_bg(c)
    # top accent band
    c.setFillColor(GREEN)
    c.rect(0, PAGE_H - 6 * mm, PAGE_W, 6 * mm, stroke=0, fill=1)
    # bottom hairline + footer
    c.setStrokeColor(RULE)
    c.setLineWidth(0.7)
    c.line(MARGIN_X, MARGIN_BOT, PAGE_W - MARGIN_X, MARGIN_BOT)
    c.setFillColor(INK_FAINT)
    c.setFont(BODY_FONT, 8)
    c.drawString(MARGIN_X, MARGIN_BOT - 4.5 * mm,
                 "Wireless Multicam Studio  |  Open-source, LAN-only. Nothing is uploaded.")


def content_page(c, doc):
    draw_bg(c)
    # running header
    c.setFillColor(GREEN_DARK)
    c.setFont(BOLD_FONT, 8.5)
    c.drawString(MARGIN_X, PAGE_H - 12 * mm, "WIRELESS MULTICAM STUDIO")
    c.setFillColor(INK_FAINT)
    c.setFont(BODY_FONT, 8.5)
    c.drawRightString(PAGE_W - MARGIN_X, PAGE_H - 12 * mm, "Tester Quick-Start")
    c.setStrokeColor(RULE)
    c.setLineWidth(0.7)
    c.line(MARGIN_X, PAGE_H - 14.5 * mm, PAGE_W - MARGIN_X, PAGE_H - 14.5 * mm)
    # footer
    c.line(MARGIN_X, MARGIN_BOT - 1 * mm, PAGE_W - MARGIN_X, MARGIN_BOT - 1 * mm)
    c.setFillColor(INK_FAINT)
    c.setFont(BODY_FONT, 8)
    c.drawString(MARGIN_X, MARGIN_BOT - 5.5 * mm,
                 "Wireless Multicam Studio - Tester Quick-Start")
    c.setFont(BODY_FONT, 8)
    c.drawRightString(PAGE_W - MARGIN_X, MARGIN_BOT - 5.5 * mm, f"Page {doc.page - 1}")


# ----------------------------------------------------------------------------
# Build document
# ----------------------------------------------------------------------------
def build():
    doc = BaseDocTemplate(
        OUTPUT, pagesize=A4,
        leftMargin=MARGIN_X, rightMargin=MARGIN_X,
        topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOT,
        title="Wireless Multicam Studio - Tester Quick-Start",
        author="Wireless Multicam Studio",
        subject="Tester quick-start guide",
    )

    content_w = PAGE_W - 2 * MARGIN_X

    # Cover frame: a tall frame, content vertically arranged
    cover_frame = Frame(
        MARGIN_X, MARGIN_BOT, content_w, PAGE_H - MARGIN_TOP - MARGIN_BOT,
        id="cover", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
    )
    body_frame = Frame(
        MARGIN_X, MARGIN_BOT + 2 * mm, content_w,
        PAGE_H - (PAGE_H - 14.5 * mm) + (PAGE_H - 16 * mm) - MARGIN_BOT - 2 * mm,
        id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
    )
    # Recompute body frame cleanly: from just under header to just above footer.
    body_top = PAGE_H - 18 * mm
    body_bottom = MARGIN_BOT + 2 * mm
    body_frame = Frame(
        MARGIN_X, body_bottom, content_w, body_top - body_bottom,
        id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
    )

    doc.addPageTemplates([
        PageTemplate(id="Cover", frames=[cover_frame], onPage=cover_page),
        PageTemplate(id="Content", frames=[body_frame], onPage=content_page),
    ])

    story = []

    # ---------------------- COVER ----------------------
    story.append(Spacer(1, 14 * mm))
    story.append(Paragraph("TESTER QUICK-START GUIDE", styles["cover_eyebrow"]))
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("Wireless Multicam Studio", styles["cover_title"]))
    story.append(Spacer(1, 4 * mm))
    story.append(HRule(46 * mm, color=GREEN, thickness=3, space_after=0))
    story.append(Spacer(1, 7 * mm))
    story.append(Paragraph(
        "Turn your laptop into a multi-camera studio and a phone into a wireless "
        "camera, in about 10 minutes.",
        styles["cover_sub"],
    ))
    story.append(Spacer(1, 14 * mm))

    # "At a glance" info card on the cover
    glance_rows = [
        [Paragraph("What this is", styles["cover_meta_strong"]),
         Paragraph("An open-source Windows tool that links phones and webcams into "
                   "one synchronized multi-camera recording rig over your local WiFi.",
                   styles["cover_meta"])],
        [Paragraph("On the phone", styles["cover_meta_strong"]),
         Paragraph("No app to install. Phones connect through their normal web browser "
                   "(Safari on iPhone, Chrome on Android).", styles["cover_meta"])],
        [Paragraph("Your data", styles["cover_meta_strong"]),
         Paragraph("Everything stays on your network. No internet connection, no "
                   "account, and nothing is uploaded to the cloud.", styles["cover_meta"])],
        [Paragraph("Time needed", styles["cover_meta_strong"]),
         Paragraph("About 10 minutes for first setup. Later sessions take under a minute.",
                   styles["cover_meta"])],
    ]
    glance = Table(glance_rows, colWidths=[34 * mm, content_w - 34 * mm])
    glance.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), HexColor("#f7faf8")),
        ("BOX", (0, 0), (-1, -1), 0.7, GREEN_LINE),
        ("LINEBELOW", (0, 0), (-1, -2), 0.6, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 3.6 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.6 * mm),
    ]))
    story.append(glance)

    story.append(NextPageTemplate("Content"))
    story.append(PageBreak())

    # ---------------------- WHAT YOU NEED ----------------------
    story.append(Paragraph("What you need", styles["section"]))
    story.append(HRule(content_w, color=RULE, thickness=0.7, space_after=2))
    story.append(Spacer(1, 4 * mm))

    need_items = [
        ("A Windows 10/11 laptop or desktop.",
         "This is the machine that runs the studio."),
        ("One or more phones.",
         "iPhone with Safari, or Android with Chrome. No app install needed."),
        ("All devices on the SAME WiFi / network.",
         "No internet connection is required."),
        ("(Optional) a webcam on the laptop.",
         "Handy if you want a second angle without using a phone."),
    ]
    need_rows = []
    for head, sub in need_items:
        cell = [
            Paragraph(f'{b(head)}', styles["callout_body"]),
            Paragraph(sub, ParagraphStyle("ns", parent=styles["callout_body"],
                                          textColor=INK_SOFT, fontSize=9, spaceBefore=1)),
        ]
        inner = Table([[c] for c in cell], colWidths=[content_w - 10 * mm - 12])
        inner.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ]))
        check = Paragraph(
            f'<font color="#16a34a" face="{BOLD_FONT}" size="11">&#10003;</font>',
            styles["callout_body"])
        need_rows.append([check, inner])

    need_tbl = Table(need_rows, colWidths=[8 * mm, content_w - 8 * mm])
    need_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, -1), 2),
        ("RIGHTPADDING", (0, 0), (0, -1), 4 * mm),
        ("LEFTPADDING", (1, 0), (1, -1), 0),
        ("RIGHTPADDING", (1, 0), (1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("LINEBELOW", (0, 0), (-1, -2), 0.6, RULE),
    ]))
    story.append(need_tbl)
    story.append(Spacer(1, 8 * mm))

    # ---------------------- STEPS HEADER ----------------------
    story.append(Paragraph("Step-by-step", styles["section"]))
    story.append(HRule(content_w, color=RULE, thickness=0.7, space_after=2))
    story.append(Spacer(1, 5 * mm))

    cw = content_w

    # STEP 1
    s1 = [
        Paragraph(
            f'Download the {chip("WirelessMulticamStudio-Setup")} installer (from the website&#8217;s '
            f'{chip("Download")} button or the GitHub Releases page) and run it.',
            styles["body"]),
        Paragraph(
            f'Windows SmartScreen will warn that it&#8217;s unsigned &mdash; click '
            f'{chip("More info")}, then {chip("Run anyway")}. It&#8217;s safe; it&#8217;s '
            f'just not code-signed yet.',
            styles["body"]),
        Paragraph(
            f'It installs and adds Start Menu and desktop shortcuts. Launch '
            f'{chip("Wireless Multicam Studio")}. It runs quietly as a system-tray icon '
            f'(bottom-right of the taskbar) &mdash; there is no app window.',
            styles["body"]),
    ]
    story.append(make_step(1, "Install the studio &mdash; on the laptop", s1, cw))

    # STEP 2
    s2 = [
        Paragraph(
            "The studio needs a local security certificate so phones are allowed to use "
            "their cameras.",
            styles["body"]),
        Paragraph(
            f'If you didn&#8217;t run it during install: right-click the tray icon and choose '
            f'{chip("First-time HTTPS setup")}. Approve the Windows admin prompt (UAC).',
            styles["body"]),
        callout("You only do this once per laptop.",
                "After the certificate is set up, you won&#8217;t be prompted again on this "
                "machine.", kind="tip", width=cw - 13 * mm),
    ]
    story.append(make_step(2, "One-time HTTPS setup &mdash; on the laptop", s2, cw))

    # STEP 3
    s3 = [
        Paragraph(
            f'Right-click the tray icon and choose {chip("Open Operator Dashboard")}. '
            f'It opens at <font face="{BOLD_FONT}" color="#155e34">https://studio.localhost:8444/</font>. '
            f'This is your control room &mdash; every camera shows up here.',
            styles["body"]),
        callout("Optional &mdash; add the laptop&#8217;s own webcam",
                f'Right-click the tray icon and choose {chip("Open Device Page")}, then join '
                f'as a camera from the laptop to use it as an extra angle.',
                kind="tip", width=cw - 13 * mm),
    ]
    story.append(make_step(3, "Open the Operator Dashboard &mdash; on the laptop", s3, cw))

    # STEP 4 (with sub-steps 4a/4b/4c)
    def substep(label, flows):
        lab = Paragraph(label, styles["substep_label"])
        inner = Table([[f] for f in flows], colWidths=[cw - 13 * mm - 9 * mm])
        inner.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        t = Table([[lab, inner]], colWidths=[9 * mm, cw - 13 * mm - 9 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), 2 * mm),
            ("RIGHTPADDING", (1, 0), (1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5 * mm),
        ]))
        return t

    s4 = [
        substep("4a", [
            Paragraph(b("Get the device link onto the phone.") +
                      " The phone must be on the same WiFi.", styles["body"]),
            Paragraph(
                f'<b>Easiest:</b> right-click the tray icon &#8594; {chip("Show Device QR (scan to connect)")} '
                f'and scan the QR code with the phone&#8217;s camera.',
                styles["body"]),
            Paragraph(
                f'<b>Or:</b> right-click the tray icon &#8594; {chip("Show URLs")} and type the '
                f'{chip("Devices")} address into the phone&#8217;s browser.',
                styles["body"]),
        ]),
        substep("4b", [
            Paragraph(b("Install the certificate on the phone &mdash; one time per phone.") +
                      f' The device page has a guided {chip("Download certificate")} button with '
                      f'step-by-step instructions and a QR code. In short:',
                      styles["body"]),
            Paragraph(
                f'<b>iPhone (iOS):</b> open/download the certificate and install the profile, then go to '
                f'<font face="{BOLD_FONT}">Settings &#8594; General &#8594; About &#8594; Certificate Trust Settings</font> '
                f'and turn ON full trust for the certificate. Both steps are required, or the camera stays blocked.',
                styles["body"]),
            Paragraph(
                f'<b>Android:</b> download the certificate, then '
                f'<font face="{BOLD_FONT}">Settings &#8594; Security &#8594; {chip("Install a certificate")} '
                f'&#8594; {chip("CA certificate")}</font>.',
                styles["body"]),
        ]),
        substep("4c", [
            Paragraph(
                f'<b>Join.</b> Reload the device page, type a name (e.g. &#8220;Stage Cam&#8221;), '
                f'pick a source ({chip("Camera")}, {chip("Screen share")}, or {chip("Audio-only")}), '
                f'and tap {chip("Join")}.',
                styles["body"]),
            Paragraph("For a phone camera, turn the phone to landscape.", styles["body"]),
        ]),
    ]
    story.append(make_step(4, "Connect a phone as a camera", s4, cw))

    # STEP 5
    s5 = [
        Paragraph(
            f'Under {chip("Cameras")}, add a camera and assign your joined phone to it.',
            styles["body"]),
        Paragraph(
            f'Click {chip("Start Preview (all)")} &mdash; the live feed appears in the grid. '
            f'Frame your shot.',
            styles["body"]),
        Paragraph(
            f'(Optional) click {chip("Pre-flight")} to confirm every camera is live, has audio, '
            f'and the disk is writable.',
            styles["body"]),
        Paragraph(
            f'Click the red '
            f'<font face="{BOLD_FONT}" color="#dc2626">&#9679; Record</font> button '
            f'&mdash; every angle records at full quality.',
            styles["body"]),
        Paragraph(
            f'While recording, click a feed tile (or press number keys '
            f'<font face="{BOLD_FONT}">1&#8211;9</font>) to mark which camera is the '
            f'<font face="{BOLD_FONT}" color="#dc2626">program &#8220;take&#8221;</font>. '
            f'The switch log records every cut.',
            styles["body"]),
        Paragraph(
            f'Click {chip("Stop Recording")} when you&#8217;re done.',
            styles["body"]),
    ]
    story.append(make_step(5, "Record a quick test &mdash; on the Operator Dashboard", s5, cw))

    # STEP 6
    s6 = [
        Paragraph(
            f'Click {chip("Recordings")} in the header to browse and download the per-camera '
            f'files and the switch log, preview the program edit in the browser, or '
            f'{chip("Export")} the whole thing as one finished MP4.',
            styles["body"]),
    ]
    story.append(make_step(6, "Get your recordings", s6, cw))

    # ---------------------- TIPS / TROUBLESHOOTING ----------------------
    tips = [
        callout("Nothing leaves your network",
                "Everything stays on your WiFi &mdash; no internet, no account, nothing "
                "uploaded.", kind="tip", width=cw),
        callout("Camera blocked on the phone?",
                "The certificate isn&#8217;t trusted yet &mdash; re-check Step 4b. On iPhone "
                "the camera is silently blocked until the cert is fully trusted.",
                kind="tip", width=cw),
        callout("Changed WiFi networks?",
                "Just relaunch the studio; the phone stays trusted &mdash; no need to "
                "reinstall the certificate.", kind="tip", width=cw),
        callout("Security: LAN-only, no password",
                "Anyone on the same WiFi who opens the operator address can control it. "
                "Test on a network you trust.", kind="warn", width=cw),
    ]
    # Start the troubleshooting section on its own page so all four callouts read
    # as one clean, scannable reference page rather than two stranded boxes.
    story.append(PageBreak())
    story.append(Paragraph("Tips &amp; troubleshooting", styles["section"]))
    story.append(HRule(content_w, color=RULE, thickness=0.7, space_after=2))
    story.append(Spacer(1, 5 * mm))
    for i, t in enumerate(tips):
        story.append(t)
        if i < len(tips) - 1:
            story.append(Spacer(1, 4.5 * mm))

    doc.build(story)
    print("WROTE:", OUTPUT)


if __name__ == "__main__":
    build()
