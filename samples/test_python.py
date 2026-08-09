"""Set a breakpoint on the final print to exercise Python image parsers."""

import io

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
pil_buffer = io.BytesIO()
pil_rgb.save(pil_buffer, format="PNG")
pil_buffer.seek(0)
pil_file = Image.open(pil_buffer)

try:
    import torch

    # Avoid relying on the optional PyTorch/NumPy ABI bridge in this sample.
    tensor_chw = torch.arange(3 * 100 * 100, dtype=torch.uint8).reshape(3, 100, 100)
except (ImportError, RuntimeError):
    tensor_chw = None

print("Set a breakpoint here and inspect the image variables")
