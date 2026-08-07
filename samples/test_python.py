"""Set a breakpoint on the final print to exercise Python image parsers."""

import cv2
import numpy as np
from PIL import Image


gray = np.arange(10000, dtype=np.uint8).reshape(100, 100)
bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
float_image = gray.astype(np.float32) / 255.0
non_contiguous = bgr[:, ::2, :]

pil_rgb = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
pil_rgba = pil_rgb.convert("RGBA")
pil_palette = pil_rgb.convert("P")

try:
    import torch

    tensor_chw = torch.from_numpy(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).permute(2, 0, 1)
except (ImportError, RuntimeError):
    tensor_chw = None

print("Set a breakpoint here and inspect the image variables")
