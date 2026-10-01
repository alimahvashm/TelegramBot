"""Small, bounded copies of lecture photos for PDF attachment."""
import io
from PIL import Image, ImageOps, UnidentifiedImageError
from .errors import AppError

MAX_EDUCATION_IMAGES = 10
MAX_STORED_IMAGE = 400 * 1024


def prepare_education_image(data: bytes) -> bytes:
    if not data or len(data) > 5 * 1024 * 1024:
        raise AppError('Each photo must be smaller than 5 MB.', 413)
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > 16_000_000:
                raise AppError('The photo resolution is too large.', 413)
            image = ImageOps.exif_transpose(source).convert('RGB')
            image.thumbnail((1280, 1280))
            for quality in (75, 60, 45):
                output = io.BytesIO()
                image.save(output, format='JPEG', quality=quality, optimize=True)
                if output.tell() <= MAX_STORED_IMAGE:
                    return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise AppError('Send a readable photo.', 415)
    raise AppError('The photo could not be compressed enough for the PDF.', 413)
