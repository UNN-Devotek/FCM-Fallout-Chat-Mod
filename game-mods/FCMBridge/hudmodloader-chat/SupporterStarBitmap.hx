import flash.display.BitmapData;

/**
 * Embedded source image for Scaleform TextFieldEx inline HTML images.
 *
 * Scaleform's substitution API accepts BitmapData backed by an image linked
 * into the SWF. Runtime-only BitmapData (for example, BitmapData.draw(Shape))
 * is not accepted by the Fallout 76 GFx build.
 */
@:bitmap("assets/supporter-star.png")
@:native("supporterstarbitmap")
class SupporterStarBitmap extends BitmapData {
    // Match the constructor shape used by the working legacy HUD assets.
    // Scaleform's GFx BitmapData bridge rejects the generated four-argument
    // Haxe constructor even when width and height are valid.
    public function new(width:Int = 128, height:Int = 128) {
        super(width, height);
    }
}

// Fallout 76's Scaleform build accepts embedded BitmapData but rejects the
// runtime ColorTransform path. Keep one embedded, catalog-coloured source per
// allowed star colour so the selected colour remains available without a
// runtime pixel operation.
@:bitmap("assets/supporter-star-EDABAB.png")
@:native("supporterstarbitmapedabab")
class SupporterStarBitmapEdabab extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-EAEA9A.png")
@:native("supporterstarbitmapeaea9a")
class SupporterStarBitmapEaea9a extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-B8CF81.png")
@:native("supporterstarbitmapb8cf81")
class SupporterStarBitmapB8cf81 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-8CDB57.png")
@:native("supporterstarbitmap8cdb57")
class SupporterStarBitmap8cdb57 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-ABEDB5.png")
@:native("supporterstarbitmapabedb5")
class SupporterStarBitmapAbedb5 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-7EC8AE.png")
@:native("supporterstarbitmap7ec8ae")
class SupporterStarBitmap7ec8ae extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-57DBDB.png")
@:native("supporterstarbitmap57dbdb")
class SupporterStarBitmap57dbdb extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-ABBFED.png")
@:native("supporterstarbitmapabbfed")
class SupporterStarBitmapAbbfed extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-868DCB.png")
@:native("supporterstarbitmap868dcb")
class SupporterStarBitmap868dcb extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-EBA2EB.png")
@:native("supporterstarbitmapeba2eb")
class SupporterStarBitmapEba2eb extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-DF68C7.png")
@:native("supporterstarbitmapdf68c7")
class SupporterStarBitmapDf68c7 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-C87E98.png")
@:native("supporterstarbitmapc87e98")
class SupporterStarBitmapC87e98 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-FE8B8B.png")
@:native("supporterstarbitmapfe8b8b")
class SupporterStarBitmapFe8b8b extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-FD5F1C.png")
@:native("supporterstarbitmapfd5f1c")
class SupporterStarBitmapFd5f1c extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-F8FE8B.png")
@:native("supporterstarbitmapf8fe8b")
class SupporterStarBitmapF8fe8b extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-C4FD1C.png")
@:native("supporterstarbitmapc4fd1c")
class SupporterStarBitmapC4fd1c extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-70F835.png")
@:native("supporterstarbitmap70f835")
class SupporterStarBitmap70f835 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-81FE87.png")
@:native("supporterstarbitmap81fe87")
class SupporterStarBitmap81fe87 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-1CFDAE.png")
@:native("supporterstarbitmap1cfdae")
class SupporterStarBitmap1cfdae extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-58FDFD.png")
@:native("supporterstarbitmap58fdfd")
class SupporterStarBitmap58fdfd extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-7EA8F7.png")
@:native("supporterstarbitmap7ea8f7")
class SupporterStarBitmap7ea8f7 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-FD1CFD.png")
@:native("supporterstarbitmapfd1cfd")
class SupporterStarBitmapFd1cfd extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}

@:bitmap("assets/supporter-star-FD4DA6.png")
@:native("supporterstarbitmapfd4da6")
class SupporterStarBitmapFd4da6 extends BitmapData {
    public function new(width:Int = 128, height:Int = 128) { super(width, height); }
}
