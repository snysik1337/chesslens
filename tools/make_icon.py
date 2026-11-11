from PIL import Image, ImageDraw
import sys
s = 256
im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((8, 8, s - 8, s - 8), radius=44, fill=(235, 236, 208, 255))
h = s // 2
d.rectangle((h, 8 + 36, s - 8 - 0, h), fill=(115, 149, 82, 255))
d.rectangle((8, h, h, s - 8 - 36), fill=(115, 149, 82, 255))
d.pieslice((s - 8 - 88, 8, s - 8, 8 + 88), 270, 360, fill=(115, 149, 82, 255))
d.rectangle((h, 8, s - 8 - 44, 8 + 44), fill=(115, 149, 82, 255))
d.pieslice((8, s - 8 - 88, 8 + 88, s - 8), 90, 180, fill=(115, 149, 82, 255))
d.rectangle((8 + 44, s - 8 - 44, h, s - 8), fill=(115, 149, 82, 255))
# magnifier
d.ellipse((70, 70, 170, 170), outline=(38, 37, 34, 255), width=16)
d.line((158, 158, 204, 204), fill=(38, 37, 34, 255), width=20)
im.save(sys.argv[1])
