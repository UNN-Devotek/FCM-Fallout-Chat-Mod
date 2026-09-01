import flash.display.BitmapData;

/**
 * Embedded source image for Scaleform TextFieldEx substitutions.
 *
 * Scaleform's substitution API accepts BitmapData backed by an image linked
 * into the SWF. Runtime-only BitmapData (for example, BitmapData.draw(Shape))
 * is not accepted by the Fallout 76 GFx build.
 */
@:bitmap("assets/supporter-star.png")
class SupporterStarBitmap extends BitmapData {}
