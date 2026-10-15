"""Create ChatSpace's 800 × 1800 mm banner with embedded fonts and a vector QR."""
from pathlib import Path
import base64
import json
import html
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parent
W, H = 800, 1800
UNIT = 72 / 25.4  # 1 design unit = 1 mm on the physical banner
INK, MUTED, BLUE = '#1D1D1F', '#6E6E73', '#0071E3'
FONT_PATHS = {
    'CN': ('/System/Library/Fonts/STHeiti Light.ttc', 1),
    'CNM': ('/System/Library/Fonts/STHeiti Medium.ttc', 1),
    'Latin': ('/System/Library/Fonts/Supplemental/Arial.ttf', 0),
    'LatinB': ('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 0),
}
for name, (path, subfont) in FONT_PATHS.items():
    pdfmetrics.registerFont(TTFont(name, path, subfontIndex=subfont))

qr = json.loads((ROOT / 'assets/qr-matrix.json').read_text())
outlines = json.loads((ROOT / 'assets/font-outlines.json').read_text())
svgs = []
c = None

def measure(s, font, size):
    if font in outlines:
        return sum(outlines[font][ch]['advance']*size for ch in s)
    return pdfmetrics.stringWidth(s, font, size)

def txt(s, x, y, size, font='CN', color=INK, anchor='middle', tracking=0):
    # y is the baseline, measured from the top.
    width = measure(s, font, size) + max(0, len(s)-1)*tracking
    left = x - width/2 if anchor == 'middle' else x - width if anchor == 'end' else x
    c.setFillColor(HexColor(color))
    text = c.beginText(left, H-y)
    text.setFont(font, size)
    if font in outlines:
        text.setTextRenderMode(3)  # searchable semantic text underneath exact glyph outlines
    if tracking:
        text.setCharSpace(tracking)
    text.textOut(s)
    c.drawText(text)
    if font in outlines:
        cursor=left
        svgs.append(f'<g aria-label="{html.escape(s)}" fill="{color}">')
        for ch in s:
            glyph=outlines[font][ch]
            p=c.beginPath();d=[];prev=(0,0)
            for cmd in glyph['commands']:
                tag=cmd[0]
                pts=[(cursor+cmd[i]*size,H-y+cmd[i+1]*size) for i in range(1,len(cmd),2)]
                if tag=='M':p.moveTo(*pts[0]);prev=pts[0]
                elif tag=='L':p.lineTo(*pts[0]);prev=pts[0]
                elif tag=='C':p.curveTo(*pts[0],*pts[1],*pts[2]);prev=pts[2]
                elif tag=='Q':
                    a,b=pts
                    p.curveTo(prev[0]+2/3*(a[0]-prev[0]),prev[1]+2/3*(a[1]-prev[1]),b[0]+2/3*(a[0]-b[0]),b[1]+2/3*(a[1]-b[1]),*b)
                    prev=b
                elif tag=='Z':p.close()
                d.append(tag+' '.join(f'{px:.4f},{H-py:.4f}' for px,py in pts))
            c.drawPath(p,stroke=0,fill=1,fillMode=1)
            svgs.append('<path d="'+' '.join(d)+'"/>')
            cursor+=glyph['advance']*size+tracking
        svgs.append('</g>')
        return
    family = 'Arial' if font.startswith('Latin') else 'Heiti SC, PingFang SC, sans-serif'
    weight = '600' if font in ['CNM','LatinB'] else '400'
    svgs.append(f'<text x="{left}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" fill="{color}" letter-spacing="{tracking}">{html.escape(s)}</text>')

def line(x1,y1,x2,y2,color='#D2D2D7',width=0.75):
    c.setStrokeColor(HexColor(color));c.setLineWidth(width)
    c.line(x1,H-y1,x2,H-y2)
    svgs.append(f'<path d="M{x1},{y1} L{x2},{y2}" stroke="{color}" stroke-width="{width}" fill="none"/>')

def rect(x,y,w,h,color,r=0,stroke=None):
    c.setFillColor(HexColor(color))
    if stroke:c.setStrokeColor(HexColor(stroke));c.setLineWidth(0.65)
    c.roundRect(x,H-y-h,w,h,r,stroke=int(stroke is not None),fill=1)
    svgs.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{color}"' + (f' stroke="{stroke}" stroke-width="0.65"' if stroke else '') + '/>')

def path(points,color=BLUE,width=1.5,close=False,fill=False):
    p=c.beginPath();p.moveTo(points[0][0],H-points[0][1])
    for x,y in points[1:]:p.lineTo(x,H-y)
    if close:p.close()
    c.setStrokeColor(HexColor(color));c.setFillColor(HexColor(color));c.setLineWidth(width)
    c.drawPath(p,stroke=1,fill=int(fill))
    d='M'+' L'.join(f'{x},{y}' for x,y in points)+(' Z' if close else '')
    svgs.append(f'<path d="{d}" fill="{color if fill else "none"}" stroke="{color}" stroke-width="{width}" stroke-linejoin="round"/>')

def spark(x,y,scale=1):
    a=8*scale;b=2.5*scale
    path([(x,y-a),(x+b,y-b),(x+a,y),(x+b,y+b),(x,y+a),(x-b,y+b),(x-a,y),(x-b,y-b)],BLUE,0.5,True,True)

def cube(x,y):
    path([(x,y-14),(x+14,y-6),(x+14,y+10),(x,y+18),(x-14,y+10),(x-14,y-6),(x,y-14)],INK,1.5)
    path([(x-14,y-6),(x,y+2),(x+14,y-6)],INK,1.5)
    line(x,y+2,x,y+18,INK,1.5)

def material(x,y):
    rect(x-13,y-13,26,26,'#F5F5F7',6,INK)
    line(x-9,y+9,x+9,y-9,INK,1.4)
    line(x-9,y+1,x+1,y-9,INK,1.4)
    line(x-1,y+9,x+9,y-1,INK,1.4)

def world(x,y):
    path([(x-14,y+13),(x-14,y-10),(x+3,y-10),(x+3,y-1),(x+14,y-1),(x+14,y+13),(x-14,y+13)],INK,1.5)
    line(x-5,y-10,x-5,y+13,INK,1.5)
    line(x+3,y-1,x+3,y+13,INK,1.5)

def compose():
    rect(0,0,W,H,'#FFFFFF')
    txt('ChatSpace',400,125,43,'LatinB',tracking=-1.7)
    txt('对话式 AI 3D 创作平台',400,181,20,'CN',MUTED,tracking=1.1)

    txt('一句话，',400,303,76,'CNM',tracking=-1.5)
    # A restrained blue ending, with the whole line optically centred.
    parts=[('创造一个',INK),('世界。',BLUE)]
    size=76;tracking=-1.5
    total=sum(measure(s,'CNM',size)+len(s)*tracking for s,_ in parts)-tracking
    left=400-total/2
    for s,col in parts:
        txt(s,left,394,size,'CNM',col,'start',tracking)
        left+=measure(s,'CNM',size)+len(s)*tracking
    txt('从文字或图片出发',400,463,22,'CN',MUTED)
    txt('让模型、材质与场景逐步成形',400,499,22,'CN',MUTED)

    hero=ROOT/'assets/space-hero.png'
    c.drawImage(ImageReader(str(hero)),0,H-565-600,800,600,mask='auto')
    encoded=base64.b64encode(hero.read_bytes()).decode()
    svgs.append(f'<image x="0" y="565" width="800" height="600" href="data:image/png;base64,{encoded}"/>')

    rect(157,1184,486,59,'#F5F5F7',29.5)
    spark(187,1213,0.9)
    txt('创建一个温暖、通透的客厅。',412,1220,21,'CN',INK)

    xs=[173,400,627]
    cube(xs[0],1310);material(xs[1],1310);world(xs[2],1310)
    for x,title,sub in zip(xs,['生成模型','编辑材质','搭建世界'],['文字 / 图片生成','贴图替换与调整','场景摆放与漫游']):
        txt(title,x,1370,25,'CNM')
        txt(sub,x,1407,16,'CN',MUTED)

    line(75,1467,725,1467)
    # QR's 4-module quiet zone is contained in the 114 mm square.
    qx,qy,sz=97,1510,114
    rect(qx,qy,sz,sz,'#FFFFFF')
    u=sz/len(qr)
    for row,cells in enumerate(qr):
        for col,dark in enumerate(cells):
            if dark:rect(qx+col*u,qy+row*u,u,u,INK)
    txt('从一句想法开始。',249,1537,29,'CNM',anchor='start')
    txt('扫码探索 ChatSpace',250,1580,21,'CN',MUTED,'start')
    txt('www.junwei.cool',250,1617,21,'Latin',INK,'start')
    c.linkURL('https://www.junwei.cool/',(qx,H-qy-sz,690,H-qy),relative=1,thickness=0)
    txt('ChatSpace  /  把想法带进三维空间',400,1684,15,'CN',MUTED)

def make_pdf(bleed):
    global c,svgs
    svgs=[]
    name='ChatSpace-80x180cm'+('-3mm-bleed' if bleed else '')+'.pdf'
    c=canvas.Canvas(str(ROOT/name),pagesize=((W+2*bleed)*UNIT,(H+2*bleed)*UNIT),pageCompression=1)
    c.setTitle('ChatSpace | 80 × 180 cm Roll-up Banner')
    c.setAuthor('ChatSpace')
    c.setSubject('Apple-inspired minimal exhibition roll-up. Vector text and QR; AI concept illustration.')
    c.setFillColor(HexColor('#FFFFFF'));c.rect(0,0,(W+2*bleed)*UNIT,(H+2*bleed)*UNIT,fill=1,stroke=0)
    if bleed:
        c.setTrimBox((bleed*UNIT,bleed*UNIT,(W+bleed)*UNIT,(H+bleed)*UNIT))
        c.setBleedBox((0,0,(W+2*bleed)*UNIT,(H+2*bleed)*UNIT))
    c.saveState();c.translate(bleed*UNIT,bleed*UNIT);c.scale(UNIT,UNIT)
    compose();c.restoreState();c.showPage();c.save()
    if not bleed:
        svg='<svg xmlns="http://www.w3.org/2000/svg" width="800mm" height="1800mm" viewBox="0 0 800 1800">'+''.join(svgs)+'</svg>'
        (ROOT/'ChatSpace-80x180cm-editable.svg').write_text(svg)

make_pdf(0)
make_pdf(3)
print('Created two physical-size PDFs and one editable SVG.')
