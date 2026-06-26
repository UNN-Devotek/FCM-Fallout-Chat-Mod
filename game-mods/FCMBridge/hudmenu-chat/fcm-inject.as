      public function fcmInit() : void
      {
         if(this._fcmInited)
         {
            return;
         }
         this._fcmInited = true;
         try
         {
            Extensions.enabled = true;
         }
         catch(eExt:Error)
         {
         }
         this._fcmZfe = this.fcmFindZfe(this);
         this.fcmLog("info","load","hudmenu-init zfe=" + (this._fcmZfe != null));
         this.fcmApplyIniDefaults();
         // Standalone variant: self-load FCMBridge.swf when HUDModLoader is absent.
         // fcmSelfLoadBridge is conditional — it checks whether the bridge is already
         // present (HUDModLoader loaded it) before issuing a Loader.load so the SAME
         // HUDMenu.swf works under both the WITH-HUDModLoader and standalone builds.
         this.fcmSelfLoadBridge();
      }

      // Pass the __ZFE reference we hold at the HUDMenu (parent) level down to
      // the FCMBridge child SWF. ZFE 0.9.8 sets child_bridge_access=disabled so
      // it does NOT inject __ZFE into child SWFs; the parent holds it normally.
      // Sharing it here lets FCMBridge connect even without HUDModLoader.
      public function fcmPassZfeToBridge() : void
      {
         if(this._fcmBridge == null) { return; }
         try
         {
            // Discover __ZFE using the documented order at the HUDMenu level.
            var hostZfe:* = null;
            try { hostZfe = this["__ZFE"]; } catch(e0:Error) {}
            if(hostZfe == null)
            {
               try { if(this.parent != null) { hostZfe = this.parent["__ZFE"]; } } catch(e1:Error) {}
            }
            if(hostZfe == null)
            {
               try { if(this.root != null) { hostZfe = this.root["__ZFE"]; } } catch(e2:Error) {}
            }
            if(hostZfe == null)
            {
               try { hostZfe = ZFECodeObj; } catch(e3:Error) {}
            }
            if(hostZfe == null)
            {
               try { hostZfe = __SFCodeObj; } catch(e4:Error) {}
            }
            var found:String = (hostZfe != null) ? "found" : "absent";
            this.fcmLog("info","zfe","hostZfe=" + found);
            if(hostZfe != null)
            {
               try { this._fcmBridge.fcmSetZfe(hostZfe); }
               catch(eSet:Error)
               {
                  this.fcmLog("warn","zfe","fcmSetZfe threw: " + eSet.message);
               }
            }
         }
         catch(ePass:Error)
         {
            this.fcmLog("warn","zfe","fcmPassZfeToBridge threw: " + ePass.message);
         }
      }

      // Self-load FCMBridge.swf into the HUD when HUDModLoader is NOT present.
      // Uses flash.display.Loader (SWF loader — works in GFx) NOT URLLoader
      // (data loader — sandbox-blocked in GFx). Shares ApplicationDomain so
      // FCMBridge lands in the same domain and fcmFindBridge can find it.
      // CONDITIONAL: bails out immediately if the bridge is already present.
      public function fcmSelfLoadBridge() : void
      {
         // Scan stage children for an existing FCMBridge instance.
         try
         {
            var st:* = this.stage;
            if(st != null)
            {
               var nc:int = int(st.numChildren);
               var si:int = 0;
               while(si < nc)
               {
                  try
                  {
                     var sc:* = st.getChildAt(si);
                     var sn:String = "";
                     try { sn = String(sc.name); } catch(eN:Error) {}
                     if(sn == "FCMBridge" || sn == "FCMBridgeClip")
                     {
                        this.fcmLog("info","selfload","FCMBridge child found on stage by name — skip self-load");
                        this._fcmBridge = sc;
                        this.fcmPassZfeToBridge();
                        return;
                     }
                  }
                  catch(eSc:Error) {}
                  si = si + 1;
               }
            }
         }
         catch(eSt:Error)
         {
            this.fcmLog("warn","selfload","stage scan threw: " + eSt.message);
         }
         // Bridge not found — standalone path: load FCMBridge.swf via Loader.
         this.fcmLog("info","selfload","bridge absent — loading FCMBridge.swf via Loader");
         try
         {
            var ldr:* = new flash.display.Loader();
            var ctx:* = new flash.system.LoaderContext(false, flash.system.ApplicationDomain.currentDomain);
            try
            {
               ldr.contentLoaderInfo.addEventListener("complete", this.fcmOnBridgeLoaded);
            }
            catch(eEv:Error)
            {
               this.fcmLog("warn","selfload","addEventListener failed: " + eEv.message);
            }
            try
            {
               ldr.contentLoaderInfo.addEventListener("ioError", this.fcmOnBridgeLoadError);
               ldr.contentLoaderInfo.addEventListener("securityError", this.fcmOnBridgeLoadError);
            }
            catch(eEr:Error) {}
            ldr.load(new flash.net.URLRequest("FCMBridge.swf"), ctx);
            try
            {
               this.addChild(ldr);
            }
            catch(eAC:Error)
            {
               this.fcmLog("warn","selfload","addChild threw: " + eAC.message);
            }
            this.fcmLog("info","selfload","Loader.load(FCMBridge.swf) issued");
         }
         catch(eLdr:Error)
         {
            this.fcmLog("warn","selfload","Loader instantiation threw: " + eLdr.message);
         }
      }

      // Called when FCMBridge.swf finishes loading (standalone path only).
      public function fcmOnBridgeLoaded(evt:*) : void
      {
         this.fcmLog("info","selfload","FCMBridge.swf load complete — re-scanning for bridge");
         try
         {
            var st:* = this.stage;
            if(st != null)
            {
               var n:int = int(st.numChildren);
               for(var i:int = 0; i < n; i++)
               {
                  try
                  {
                     var sc:* = st.getChildAt(i);
                     var sn:String = "";
                     try { sn = String(sc.name); } catch(eN:Error) {}
                     if(sn == "FCMBridge" || sn == "FCMBridgeClip" || sc.fcmSendMessage != null)
                     {
                        this._fcmBridge = sc;
                        this.fcmLog("info","selfload","bridge found after self-load OK");
                        this.fcmPassZfeToBridge();
                        return;
                     }
                  }
                  catch(eC:Error) {}
               }
            }
         }
         catch(eSt:Error) {}
         this.fcmLog("warn","selfload","bridge NOT found after self-load");
      }

      // Called on ioError / securityError during self-load.
      public function fcmOnBridgeLoadError(evt:*) : void
      {
         var msg:String = "";
         try { msg = String(evt.text); } catch(eM:Error) {}
         this.fcmLog("warn","selfload","FCMBridge.swf load FAILED: " + msg);
      }

      public function fcmApplyIniDefaults() : void
      {
         // Default position values — players can override in zfe.ini.
         this._fcmIniX = 50;
         this._fcmIniY = 780;
         this._fcmIniW = 500;
         this._fcmIniH = 30;
         this._fcmIniFontSize = 14;
         // OpenChatKey matches [TextChat] OpenChatKey in FCM.ini fragment.
         this._fcmIniOpenKey = "PAGE_DOWN";
         this._fcmIniLoaded = true;
         // Default channel index (0 = global).
         this._fcmChannelIdx = 0;
         this._fcmChannelSlug = "global";
      }

      // Channel slug table — indices 0-4 map GENERAL/TRADING/EVENTS/INFESTS/RAIDS.
      // "server" (index 5) is not directly selectable via the tab UI.
      // Slugs MUST match AllowedChannels in Data/ZFE/TextChat/fragments/FCM.ini.
      public function fcmChannelSlug(idx:int) : String
      {
         if(idx == 1) { return "trade"; }
         if(idx == 2) { return "events"; }
         if(idx == 3) { return "infests"; }
         if(idx == 4) { return "raids"; }
         return "global";
      }

      public function fcmChannelName(idx:int) : String
      {
         if(idx == 1) { return "Trading"; }
         if(idx == 2) { return "Events"; }
         if(idx == 3) { return "Infests"; }
         if(idx == 4) { return "Raids"; }
         return "General";
      }

      // Switch the active channel and notify FCMBridge.
      public function fcmPublishChannel() : void
      {
         var name:String = this.fcmChannelName(this._fcmChannelIdx);
         this._fcmChannelSlug = this.fcmChannelSlug(this._fcmChannelIdx);
         // Update input prompt channel tag.
         try
         {
            if(this.HUDChatBase_mc != null)
            {
               var ew:* = this.HUDChatBase_mc.HUDChatEntryWidget_mc;
               if(ew != null)
               {
                  var ch:* = ew.ChatEntryChannel_tf;
                  if(ch != null) { ch.text = "[" + name + "]"; }
               }
            }
         }
         catch(eTag:Error) {}
         // Tell FCMBridge to switch its active channel filter.
         if(this._fcmBridge != null)
         {
            try { this._fcmBridge.fcmSwitchChannelTo(this._fcmChannelIdx); }
            catch(eSwitch:Error)
            {
               this.fcmLog("warn","chan","fcmSwitchChannelTo threw: " + eSwitch.message);
            }
         }
         this.fcmLog("info","chan","channel=" + name + " slug=" + this._fcmChannelSlug);
      }

      // Cycle the active channel: General -> Trading -> Events -> Infests -> Raids -> General.
      // Triggered by the NextPage control-map action (Page Down key — dead in FO76 HUD).
      public function fcmSwitchChannel() : void
      {
         this._fcmChannelIdx = (this._fcmChannelIdx + 1) % 5;
         this._fcmChannelSlug = this.fcmChannelSlug(this._fcmChannelIdx);
         this.fcmPublishChannel();
      }

      public function fcmEvent(action:String, pressed:Boolean) : void
      {
         // Chat-open hotkey: PAGE_DOWN (dead in FO76 HUD, matches OpenChatKey in FCM.ini).
         // Also accept TeamChat and Console (legacy) as aliases. Open on key-UP only.
         var openKey:String = (this._fcmIniOpenKey != null && this._fcmIniOpenKey.length > 0) ? this._fcmIniOpenKey : "PAGE_DOWN";
         if((action == openKey || action == "Console" || action == "ConsoleToggles" || action == "TeamChat") && !pressed)
         {
            this.fcmLog("info","open",action + " -> enterChatMode");
            try
            {
               this.enterChatMode();
               this.fcmStyleInput();
            }
            catch(eOpen:Error)
            {
               this.fcmLog("warn","open","enterChatMode threw: " + eOpen.message);
            }
            return;
         }
         // Channel cycle: NextPage (Page Down key — dead in FO76 HUD), key-UP only.
         if(action == "NextPage" && !pressed)
         {
            this.fcmSwitchChannel();
            return;
         }
         // Suppress noisy repeated / high-frequency actions.
         if(action == "Console" || action == "ConsoleToggles" || action == "Unmapped" || action == "DISABLED")
         {
            return;
         }
         if(action == "Forward" || action == "Back" || action == "StrafeLeft" || action == "StrafeRight" || action == "Move" || action == "Look" || action == "Turn" || action == "Melee" || action == "ReadyWeapon" || action == "Attack" || action == "Run" || action == "Sprint" || action == "Jump" || action == "Ping" || action == "Activate" || action == "Sneak" || action == "ToggleRun" || action == "AutoMove")
         {
            return;
         }
         if(this._fcmLastEvent == action) { return; }
         this._fcmLastEvent = action;
         this.fcmLog("info","event",action + "~" + pressed);
      }

      public function fcmStyleInput() : void
      {
         var ew:* = null;
         var tf:* = null;
         var ch:* = null;
         var fcmInp:* = null;
         var tl:Point = null;
         var br:Point = null;
         var p:Point = null;
         var p2:Point = null;
         var w:Number = 0;
         var h:Number = 0;
         try
         {
            if(this.HUDChatBase_mc == null)
            {
               this.fcmLog("warn","style","HUDChatBase_mc is null; bail");
               return;
            }
            ew = this.HUDChatBase_mc.HUDChatEntryWidget_mc;
            if(ew == null)
            {
               this.fcmLog("warn","style","HUDChatEntryWidget_mc is null; bail");
               return;
            }
            tf = ew.ChatEntryText_tf;
            if(tf == null)
            {
               this.fcmLog("warn","style","ChatEntryText_tf is null; bail");
               return;
            }
            tf.text = "";
            tf.textColor = 0xF5CB5B;
            tf.background = false;
            tf.border = false;
            try
            {
               tf.embedFonts = true;
               if(tf.defaultTextFormat != null)
               {
                  var fmt:TextFormat = tf.defaultTextFormat;
                  if(fmt.font == null || fmt.font.length == 0) { fmt.font = "$$MAIN_Font"; }
                  if(this._fcmIniFontSize > 0) { fmt.size = this._fcmIniFontSize; }
                  fmt.color = 0xF5CB5B;
                  tf.defaultTextFormat = fmt;
               }
            }
            catch(eFnt:Error)
            {
               this.fcmLog("warn","style","font hardening threw: " + eFnt.message);
            }
            ch = ew.ChatEntryChannel_tf;
            if(ch != null) { ch.textColor = 0xF5CB5B; }
            this.HUDChatBase_mc.x = 0;
            this.HUDChatBase_mc.y = 0;
            ew.x = 0;
            ew.y = 0;
            try
            {
               InteractiveObjectEx.setTopmostLevel(this.HUDChatBase_mc, true);
            }
            catch(eTop:Error)
            {
               try { this.setChildIndex(this.HUDChatBase_mc, this.numChildren - 1); }
               catch(eZ:Error) {}
            }
            if(this._fcmInpRef == null || this._fcmInpRef.parent == null)
            {
               this._fcmInpRef = this.fcmFindByText(this.stage, "Chat via", 0);
            }
            fcmInp = this._fcmInpRef;
            // Un-hide the FCMBridge feed panel so the player sees context while typing.
            try
            {
               if(fcmInp != null && fcmInp.parent != null && fcmInp.parent.fcmWake != null)
               {
                  fcmInp.parent.fcmWake();
               }
            }
            catch(eWk:Error) {}
            if(fcmInp != null)
            {
               tl = fcmInp.localToGlobal(new Point(0,0));
               br = fcmInp.localToGlobal(new Point(fcmInp.width, fcmInp.height));
               p  = ew.globalToLocal(tl);
               p2 = ew.globalToLocal(br);
               w = p2.x - p.x;
               h = p2.y - p.y;
               if(w < 20 || h < 8)
               {
                  this.fcmLog("warn","style","geometry too small (" + int(w) + "x" + int(h) + "); using fallback");
                  this.fcmApplyFallbackPos(tf);
               }
               else
               {
                  tf.x = p.x + 8;
                  tf.y = p.y;
                  tf.width = w - 16;
                  tf.height = h;
                  try { fcmInp.visible = false; } catch(eHide:Error) {}
                  this.fcmLog("info","style","aligned to FCM input @global " + int(tl.x) + "," + int(tl.y) + " size " + int(w) + "x" + int(h));
               }
            }
            else
            {
               this.fcmApplyFallbackPos(tf);
            }
         }
         catch(eStyle:Error)
         {
            this.fcmLog("warn","style","threw: " + eStyle.message);
         }
      }

      public function fcmApplyFallbackPos(tf:*) : void
      {
         var fx:int = (this._fcmIniLoaded && this._fcmIniX > 0) ? this._fcmIniX : 13;
         var fy:int = (this._fcmIniLoaded && this._fcmIniY > 0) ? this._fcmIniY : 213;
         var fw:int = (this._fcmIniLoaded && this._fcmIniW > 0) ? this._fcmIniW : 344;
         var fh:int = (this._fcmIniLoaded && this._fcmIniH > 0) ? this._fcmIniH : 30;
         try { tf.x = fx; tf.y = fy; tf.width = fw; tf.height = fh; }
         catch(eFb:Error) {}
         this.fcmLog("warn","style","FCM input not found or bad geometry; fallback pos " + fx + "," + fy);
      }

      public function fcmFindByText(node:*, needle:String, depth:int) : *
      {
         var t:* = null;
         var n:int = 0;
         var i:int = 0;
         var c:* = null;
         if(node == null || depth > 8) { return null; }
         try
         {
            t = node.text;
            if(t != null && String(t).indexOf(needle) >= 0) { return node; }
         }
         catch(eT:Error) {}
         try { n = int(node.numChildren); } catch(eN:Error) { n = 0; }
         while(i < n)
         {
            try
            {
               c = this.fcmFindByText(node.getChildAt(i), needle, depth + 1);
               if(c != null) { return c; }
            }
            catch(eC:Error) {}
            i = i + 1;
         }
         return null;
      }

      public function fcmForward(Message:String) : void
      {
         if(Message == null || Message.length == 0) { return; }
         // Auth state gate: only allow sending when the account is linked.
         // FCMBridge.fcmCanSend() returns false when authState is "limited".
         if(this._fcmBridge != null)
         {
            try
            {
               var canSend:Boolean = Boolean(this._fcmBridge.fcmCanSend());
               if(!canSend)
               {
                  var hint:String = "";
                  try { hint = String(this._fcmBridge.fcmLinkHint()); } catch(eHint:Error) {}
                  this.fcmLog("info","send","blocked; account not linked");
                  // Re-render the input bar with the auth hint so the player sees it.
                  this.fcmShowAuthHint(hint);
                  return;
               }
            }
            catch(eGate:Error)
            {
               this.fcmLog("warn","send","fcmCanSend threw: " + eGate.message);
               // On error fall through and let FCMBridge enforce the gate defensively.
            }
         }
         // Slash-command channel switching.
         // /general /g /trading /t /events /e /infests /inf /raids /r
         var trimmed:String = Message;
         while(trimmed.length > 0 && (trimmed.charAt(0) == " " || trimmed.charAt(0) == "\t"))
         {
            trimmed = trimmed.substring(1);
         }
         var lower:String = trimmed.toLowerCase();
         var tok:String = lower;
         var sp:int = lower.indexOf(" ");
         if(sp >= 0) { tok = lower.substring(0, sp); }
         // Accept "." as alias for "/" (engine swallows "/" in vanilla chat field).
         if(tok.length > 1 && tok.charAt(0) == ".")
         {
            tok = "/" + tok.substring(1);
         }
         var slashTarget:int = -1;
         if(tok == "/general" || tok == "/gen" || tok == "/g")           { slashTarget = 0; }
         else if(tok == "/trading" || tok == "/trade" || tok == "/t")    { slashTarget = 1; }
         else if(tok == "/events"  || tok == "/event" || tok == "/e")    { slashTarget = 2; }
         else if(tok == "/infests" || tok == "/infest" || tok == "/inf" || tok == "/i") { slashTarget = 3; }
         else if(tok == "/raids"   || tok == "/raid"  || tok == "/r")    { slashTarget = 4; }
         if(slashTarget >= 0)
         {
            this._fcmChannelIdx  = slashTarget;
            this._fcmChannelSlug = this.fcmChannelSlug(slashTarget);
            this.fcmPublishChannel();
            var rest:String = "";
            if(sp >= 0) { rest = trimmed.substring(sp + 1); }
            while(rest.length > 0 && (rest.charAt(0) == " " || rest.charAt(0) == "\t"))
            {
               rest = rest.substring(1);
            }
            if(rest.length == 0) { return; }
            Message = rest;
         }
         // Truncate to 225 chars before sending.
         var cleaned:String = this.fcmClean(Message);
         if(cleaned.length > 225) { cleaned = cleaned.substring(0, 225); }
         this.fcmLog("info","send","forward len=" + cleaned.length + " slug=" + this._fcmChannelSlug);
         // Delegate send to FCMBridge (it holds the chat.v1 connection).
         if(this._fcmBridge == null)
         {
            // Re-scan stage for the bridge in case it loaded late.
            try
            {
               var stg:* = this.stage;
               if(stg != null)
               {
                  var nc:int = int(stg.numChildren);
                  for(var si:int = 0; si < nc; si++)
                  {
                     try
                     {
                        var sc:* = stg.getChildAt(si);
                        if(sc != null && sc.fcmSendMessage != null) { this._fcmBridge = sc; this.fcmPassZfeToBridge(); break; }
                     }
                     catch(eC:Error) {}
                  }
               }
            }
            catch(eSt:Error) {}
         }
         if(this._fcmBridge == null)
         {
            this.fcmLog("warn","send","no bridge; cannot forward via chat.v1");
            return;
         }
         try
         {
            this._fcmBridge.fcmSendMessage(cleaned, this._fcmChannelSlug);
         }
         catch(eSend:Error)
         {
            this.fcmLog("warn","send","fcmSendMessage threw: " + eSend.message);
         }
      }

      // Render an auth hint in the chat input bar when the account is not linked.
      // Replaces the typed text with the link-code notice so the player sees it;
      // does NOT send anything. The player must press Enter again after linking.
      public function fcmShowAuthHint(hint:String) : void
      {
         try
         {
            if(this.HUDChatBase_mc == null) { return; }
            var ew:* = this.HUDChatBase_mc.HUDChatEntryWidget_mc;
            if(ew == null) { return; }
            var tf:* = ew.ChatEntryText_tf;
            if(tf == null) { return; }
            // Show the hint as placeholder text; clear whatever the player typed.
            var msg:String = (hint != null && hint.length > 0) ? hint : "Link your account at falloutchatmod.com/link to chat";
            tf.text = msg;
            tf.textColor = 0xFF8C00;  // amber — visually distinct from normal chat text
         }
         catch(eHint:Error)
         {
            this.fcmLog("warn","hint","fcmShowAuthHint threw: " + eHint.message);
         }
      }

      public function fcmClean(s:String) : String
      {
         if(s == null) { return ""; }
         s = s.split("~").join("-");
         s = s.split("\r").join(" ");
         s = s.split("\n").join(" ");
         s = s.split("\"").join("'");
         s = s.split("\\").join("/");
         return s;
      }

      public function fcmLog(level:String, cat:String, msg:String) : void
      {
         if(this._fcmZfe == null) { this._fcmZfe = this.fcmFindZfe(this); }
         if(this._fcmZfe == null) { return; }
         var safeMsg:String = this.fcmClean(msg);
         try
         {
            this._fcmZfe.call("log","{\"vendor\":\"HUDMenuChat\",\"level\":\"" + level + "\",\"category\":\"" + cat + "\",\"message\":\"" + safeMsg + "\"}");
         }
         catch(eLog:Error) {}
      }

      public function fcmFindZfe(scope:*) : Object
      {
         var z:* = null;
         var st:* = null;
         var child:* = null;
         var gc:* = null;
         var n:int = 0;
         var m:int = 0;
         var i:int = 0;
         var j:int = 0;
         try
         {
            z = scope["__ZFE"];
            if(z != null) { return z; }
         }
         catch(e0:Error) {}
         try
         {
            st = scope.stage;
            if(st != null)
            {
               n = int(st.numChildren);
               i = 0;
               while(i < n)
               {
                  try
                  {
                     child = st.getChildAt(i);
                     try { z = child["__ZFE"]; if(z != null) { return z; } } catch(eA:Error) {}
                     try { z = child["ZFECodeObj"]; if(z != null) { return z; } } catch(eB:Error) {}
                     m = 0;
                     try { m = int(child.numChildren); } catch(eM:Error) {}
                     j = 0;
                     while(j < m)
                     {
                        try
                        {
                           gc = child.getChildAt(j);
                           z = gc["__ZFE"];
                           if(z != null) { return z; }
                        }
                        catch(eJ:Error) {}
                        j = j + 1;
                     }
                  }
                  catch(eC:Error) {}
                  i = i + 1;
               }
            }
         }
         catch(eS:Error) {}
         return null;
      }

      // Input length feedback — called from chatEntryKeyUp hook.
      public function fcmCheckLength() : void
      {
         var tf:* = null;
         try
         {
            if(this.HUDChatBase_mc == null) { return; }
            var ew:* = this.HUDChatBase_mc.HUDChatEntryWidget_mc;
            if(ew == null) { return; }
            tf = ew.ChatEntryText_tf;
            if(tf == null) { return; }
            if(tf.length > 215) { tf.textColor = 0xFF4444; }
            else { tf.textColor = 0xF5CB5B; }
            var t:String = String(tf.text);
            if(t.length > 0 && t.charAt(0) == "/")
            {
               this.fcmLog("info","type","slash-in-field len=" + t.length);
            }
         }
         catch(eCk:Error) {}
      }
