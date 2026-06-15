      public function fcmInit() : void
      {
         if(this._fcmInited)
         {
            return;
         }
         this._fcmInited = true;
         // Improvement 10: ensure Extensions.enabled before any scaleform.gfx.* call.
         try
         {
            Extensions.enabled = true;
         }
         catch(eExt:Error)
         {
         }
         this._fcmZfe = this.fcmFindZfe(this);
         this._fcmLegacy = this.fcmFindBridge(this);
         this.fcmLog("info","load","hudmenu-init zfe=" + (this._fcmZfe != null) + " bridge=" + (this._fcmLegacy != null));
         // Improvement 7: load defaults from FCMChat.ini via the ZFE bridge read API.
         // URLLoader is disabled in GFx (all networking blocked); the ZFE bridge readUTFBytes
         // verb also has no file-read path. Ship the INI for future tooling; apply defaults now.
         this.fcmApplyIniDefaults();
         // Standalone variant: self-load FCMBridge.swf when HUDModLoader is absent.
         // fcmSelfLoadBridge is conditional — it checks whether the bridge is already
         // present (HUDModLoader loaded it) before issuing a Loader.load so the SAME
         // HUDMenu.swf works under both the WITH-HUDModLoader and standalone builds.
         this.fcmSelfLoadBridge();
      }

      // Self-load FCMBridge.swf into the HUD when HUDModLoader is NOT present.
      // Uses flash.display.Loader (SWF loader — works in GFx) NOT URLLoader
      // (data loader — sandbox-blocked in GFx). Shares ApplicationDomain so
      // FCMBridge lands in the same domain and is discoverable via fcmFindBridge.
      // CONDITIONAL: bails out immediately if the bridge is already present
      // (meaning HUDModLoader already loaded it) — prevents double-load.
      public function fcmSelfLoadBridge() : void
      {
         // If the bridge is already found, HUDModLoader loaded it — nothing to do.
         if(this._fcmLegacy != null)
         {
            this.fcmLog("info","selfload","bridge already present — skip self-load (HUDModLoader path)");
            return;
         }
         // Also scan stage children for an existing FCMBridge instance by name
         // so we tolerate a race where HUDModLoader finishes just after our init.
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
                     // FCMBridge names its root clip "FCMBridge" and exposes __SFCodeObj.
                     var sn:String = "";
                     try { sn = String(sc.name); } catch(eN:Error) {}
                     if(sn == "FCMBridge" || sn == "FCMBridgeClip")
                     {
                        this.fcmLog("info","selfload","FCMBridge child found on stage by name — skip self-load");
                        return;
                     }
                     // Probe __zfe_probe discriminator: non-null and not "unsupported_command"
                     // means this IS the bridge (same check as fcmIsLegacy).
                     var sfObj:* = null;
                     try { sfObj = sc["__SFCodeObj"]; } catch(eSF:Error) {}
                     if(sfObj != null)
                     {
                        try
                        {
                           var pr:* = sfObj.call("__zfe_probe");
                           if(pr != null && !(pr is Boolean) && String(pr).indexOf("unsupported_command") < 0)
                           {
                              this.fcmLog("info","selfload","bridge __SFCodeObj probe OK on stage child — skip self-load");
                              this._fcmLegacy = sfObj;
                              return;
                           }
                        }
                        catch(ePr:Error) {}
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
         // LoaderContext(false, ApplicationDomain.currentDomain) places the loaded
         // SWF in the same domain so its ExternalInterface/__SFCodeObj is reachable.
         this.fcmLog("info","selfload","bridge absent — loading FCMBridge.swf via Loader");
         try
         {
            var ldr:* = new flash.display.Loader();
            var ctx:* = new flash.system.LoaderContext(false, flash.system.ApplicationDomain.currentDomain);
            // Listen for completion so we can re-run fcmFindBridge after load.
            try
            {
               ldr.contentLoaderInfo.addEventListener("complete", this.fcmOnBridgeLoaded);
            }
            catch(eEv:Error)
            {
               this.fcmLog("warn","selfload","addEventListener failed: " + eEv.message);
            }
            // Listen for errors so failures surface in zfe.log rather than silently vanishing.
            try
            {
               ldr.contentLoaderInfo.addEventListener("ioError", this.fcmOnBridgeLoadError);
               ldr.contentLoaderInfo.addEventListener("securityError", this.fcmOnBridgeLoadError);
            }
            catch(eEr:Error) {}
            ldr.load(new flash.net.URLRequest("FCMBridge.swf"), ctx);
            // addChild makes the Loader (and its loaded content) part of the display tree
            // so GFx keeps a reference and doesn't GC it before the load completes.
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
      // Re-runs fcmFindBridge so _fcmLegacy is populated and all pending operations
      // (HELLO, CHAN) that depend on it will succeed.
      public function fcmOnBridgeLoaded(evt:*) : void
      {
         this.fcmLog("info","selfload","FCMBridge.swf load complete — re-scanning for bridge");
         this._fcmLegacy = this.fcmFindBridge(this);
         if(this._fcmLegacy != null)
         {
            this.fcmLog("info","selfload","bridge found after self-load OK");
            // Re-publish the current channel now that the bridge is live.
            try { this.fcmPublishChannel(); } catch(eP:Error) {}
         }
         else
         {
            this.fcmLog("warn","selfload","bridge NOT found after self-load — FCMBridge.swf may lack __SFCodeObj");
         }
      }

      // Called on ioError / securityError during self-load — logs to zfe.log so it's diagnosable.
      public function fcmOnBridgeLoadError(evt:*) : void
      {
         var msg:String = "";
         try { msg = String(evt.text); } catch(eM:Error) {}
         this.fcmLog("warn","selfload","FCMBridge.swf load FAILED: " + msg);
      }

      public function fcmApplyIniDefaults() : void
      {
         // Default position values from FCMChat.ini (applied at runtime; players can override
         // by patching these constants once a file-read path is available in a future ZFE).
         // Improvement 7: stored in state so fcmApplyFallbackPos picks them up.
         this._fcmIniX = 50;
         this._fcmIniY = 780;
         this._fcmIniW = 500;
         this._fcmIniH = 30;
         this._fcmIniFontSize = 14;
         this._fcmIniOpenKey = "Console";
         this._fcmIniLoaded = true;
         // Set initial active channel state; do NOT send CHAN at init since the
         // socket is not yet connected. The backend sends ACTIVECHAN on connect.
         this._fcmChannelIdx = 0;
         this._fcmChannelId = "00000000-0000-0000-0000-000000000005";
      }

      // Channel name/UUID tables — indices 0-3 map General/Trading/Events/Raids.
      public function fcmChannelName(idx:int) : String
      {
         if(idx == 1) { return "Trading"; }
         if(idx == 2) { return "Events"; }
         if(idx == 3) { return "Infests"; }
         if(idx == 4) { return "Raids"; }
         return "General";
      }

      public function fcmChannelUuid(idx:int) : String
      {
         if(idx == 1) { return "00000000-0000-0000-0000-000000000002"; }
         if(idx == 2) { return "00000000-0000-0000-0000-000000000003"; }
         if(idx == 3) { return "983995c1-f9ab-44c0-9b78-8b4cbf497273"; }
         if(idx == 4) { return "00000000-0000-0000-0000-000000000004"; }
         return "00000000-0000-0000-0000-000000000005";
      }

      // Single canonical place that updates _fcmChannelId, the input prompt tag,
      // and notifies the backend to re-filter + replay history for the new channel.
      // Callers set _fcmChannelIdx + _fcmChannelId before calling this.
      public function fcmPublishChannel() : void
      {
         var name:String = this.fcmChannelName(this._fcmChannelIdx);
         // 1. Update input prompt tag.
         try
         {
            if(this.HUDChatBase_mc != null)
            {
               var ew:* = this.HUDChatBase_mc.HUDChatEntryWidget_mc;
               if(ew != null)
               {
                  var ch:* = ew.ChatEntryChannel_tf;
                  if(ch != null)
                  {
                     ch.text = "[" + name + "]";
                  }
               }
            }
         }
         catch(eTag:Error)
         {
         }
         // 2. Send CHAN~<channelId> to the backend so it re-filters the feed
         //    and sends an ACTIVECHAN control line back with history replay.
         //    (The old __fcmActiveChannel bridge-field write is removed — the
         //    backend now drives FCMBridge display via ACTIVECHAN control lines.)
         if(this._fcmLegacy == null)
         {
            this._fcmLegacy = this.fcmFindBridge(this);
         }
         if(this._fcmLegacy == null)
         {
            this.fcmLog("warn","chan","no bridge; cannot send CHAN");
            return;
         }
         this.fcmSend("CHAN~" + this._fcmChannelId + "\n");
         this.fcmLog("info","chan","channel=" + name + " id=" + this._fcmChannelId);
      }

      // Cycle the active channel: General -> Trading -> Events -> Raids -> General.
      // Triggered by the NextPage control-map action (Page Down key — dead in FO76 HUD).
      public function fcmSwitchChannel() : void
      {
         this._fcmChannelIdx = (this._fcmChannelIdx + 1) % 5;
         this._fcmChannelId = this.fcmChannelUuid(this._fcmChannelIdx);
         this.fcmPublishChannel();
      }

      public function fcmEvent(action:String, pressed:Boolean) : void
      {
         // Chat-open hotkeys: the ~ key fires "Console" (primary) and occasionally
         // "ConsoleToggles" — both are dead in FO76, so we claim them. Open on key-UP.
         // Improvement 7: also support _fcmIniOpenKey if set.
         var openKey:String = (this._fcmIniOpenKey != null && this._fcmIniOpenKey.length > 0) ? this._fcmIniOpenKey : "Console";
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
         // Cycles General -> Trading -> Events -> Raids -> General.
         if(action == "NextPage" && !pressed)
         {
            this.fcmSwitchChannel();
            return;
         }
         // Suppress the noisy console-key repeat (key-down) so it doesn't spam the log.
         if(action == "Console" || action == "ConsoleToggles" || action == "Unmapped" || action == "DISABLED")
         {
            return;
         }
         // Suppress high-frequency movement/combat actions to keep the socket free.
         if(action == "Forward" || action == "Back" || action == "StrafeLeft" || action == "StrafeRight" || action == "Move" || action == "Look" || action == "Turn" || action == "Melee" || action == "ReadyWeapon" || action == "Attack" || action == "Run" || action == "Sprint" || action == "Jump" || action == "Ping" || action == "Activate" || action == "Sneak" || action == "ToggleRun" || action == "AutoMove")
         {
            return;
         }
         // Everything else: log once per distinct action (dedup key-repeat) so we can
         // see exactly which action a key maps to in the current context.
         if(this._fcmLastEvent == action)
         {
            return;
         }
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
            // Improvement 9: existence guards before accessing nested path.
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
            tf.textColor = 0xF5CB5B;        // Pip-Boy amber
            // Border/background ownership: FCMBridge's inp bar provides the visible
            // box. The patch's real input field is transparent so exactly one border
            // shows (no nested box-inside-box).
            tf.background = false;
            tf.border = false;
            // Improvement 10: font hardening — keep embedFonts true with known font.
            try
            {
               tf.embedFonts = true;
               if(tf.defaultTextFormat != null)
               {
                  var fmt:TextFormat = tf.defaultTextFormat;
                  if(fmt.font == null || fmt.font.length == 0)
                  {
                     fmt.font = "$$MAIN_Font";
                  }
                  if(this._fcmIniFontSize > 0)
                  {
                     fmt.size = this._fcmIniFontSize;
                  }
                  // Color the DEFAULT format too — without this, newly typed chars
                  // render in the field's original (white) format until the next
                  // keyUp re-tints them, which the user sees as a color flicker.
                  fmt.color = 0xF5CB5B;
                  tf.defaultTextFormat = fmt;
               }
            }
            catch(eFnt:Error)
            {
               this.fcmLog("warn","style","font hardening threw: " + eFnt.message);
            }
            ch = ew.ChatEntryChannel_tf;
            if(ch != null)
            {
               ch.textColor = 0xF5CB5B;
            }
            // Zero the nesting offsets, then overlay our field exactly on the FCM
            // relay input bar (different SWF -> align via GLOBAL coordinates).
            this.HUDChatBase_mc.x = 0;
            this.HUDChatBase_mc.y = 0;
            ew.x = 0;
            ew.y = 0;
            // Improvement 5: Z-order via InteractiveObjectEx.setTopmostLevel; keep
            // setChildIndex as fallback.
            try
            {
               InteractiveObjectEx.setTopmostLevel(this.HUDChatBase_mc, true);
            }
            catch(eTop:Error)
            {
               try
               {
                  this.setChildIndex(this.HUDChatBase_mc, this.numChildren - 1);
               }
               catch(eZ:Error)
               {
               }
            }
            // Improvement 4: use cached _fcmInpRef; re-find only if null/detached.
            if(this._fcmInpRef == null || this._fcmInpRef.parent == null)
            {
               this._fcmInpRef = this.fcmFindByText(this.stage, "Chat via", 0);
            }
            fcmInp = this._fcmInpRef;
            // Auto-hide wake: opening chat counts as activity — un-hide the feed
            // panel so the player sees context while typing. fcmInp's parent IS
            // the FCMBridge widget instance (fcmWake is a public method on it).
            try
            {
               if(fcmInp != null && fcmInp.parent != null && fcmInp.parent.fcmWake != null)
               {
                  fcmInp.parent.fcmWake();
               }
            }
            catch(eWk:Error)
            {
            }
            if(fcmInp != null)
            {
               tl = fcmInp.localToGlobal(new Point(0,0));
               br = fcmInp.localToGlobal(new Point(fcmInp.width, fcmInp.height));
               p = ew.globalToLocal(tl);
               p2 = ew.globalToLocal(br);
               w = p2.x - p.x;
               h = p2.y - p.y;
               // Improvement 3: geometry sanity check before applying alignment.
               if(w < 20 || h < 8)
               {
                  this.fcmLog("warn","style","geometry too small (" + int(w) + "x" + int(h) + "); using fallback");
                  this.fcmApplyFallbackPos(tf);
               }
               else
               {
                  // Inset 8px left and 8px right so typed text doesn't touch the box edges.
                  tf.x = p.x + 8;
                  tf.y = p.y;
                  tf.width = w - 16;
                  tf.height = h;
                  // Hide the FCM "Chat via the FCM overlay..." placeholder so it doesn't
                  // bleed over/under our input box (we sit exactly on top of it now).
                  try
                  {
                     fcmInp.visible = false;
                  }
                  catch(eHide:Error)
                  {
                  }
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
         // Use INI values if loaded, else hard-coded defaults.
         var fx:int = (this._fcmIniLoaded && this._fcmIniX > 0) ? this._fcmIniX : 13;
         var fy:int = (this._fcmIniLoaded && this._fcmIniY > 0) ? this._fcmIniY : 213;
         var fw:int = (this._fcmIniLoaded && this._fcmIniW > 0) ? this._fcmIniW : 344;
         var fh:int = (this._fcmIniLoaded && this._fcmIniH > 0) ? this._fcmIniH : 30;
         try
         {
            tf.x = fx;
            tf.y = fy;
            tf.width = fw;
            tf.height = fh;
         }
         catch(eFb:Error)
         {
         }
         this.fcmLog("warn","style","FCM input not found or bad geometry; fallback pos " + fx + "," + fy);
      }

      public function fcmFindByText(node:*, needle:String, depth:int) : *
      {
         var t:* = null;
         var n:int = 0;
         var i:int = 0;
         var c:* = null;
         if(node == null || depth > 8)
         {
            return null;
         }
         try
         {
            t = node.text;
            if(t != null && String(t).indexOf(needle) >= 0)
            {
               return node;
            }
         }
         catch(eT:Error)
         {
         }
         try
         {
            n = int(node.numChildren);
         }
         catch(eN:Error)
         {
            n = 0;
         }
         while(i < n)
         {
            try
            {
               c = this.fcmFindByText(node.getChildAt(i), needle, depth + 1);
               if(c != null)
               {
                  return c;
               }
            }
            catch(eC:Error)
            {
            }
            i = i + 1;
         }
         return null;
      }

      public function fcmForward(Message:String) : void
      {
         if(Message == null || Message.length == 0)
         {
            return;
         }
         // Slash-command channel switching (fix 6).
         // Intercept /general /g /trading /t /events /e /raids /r before sending.
         // These switch the active channel and return early (nothing sent to backend).
         var trimmed:String = Message;
         while(trimmed.length > 0 && (trimmed.charAt(0) == " " || trimmed.charAt(0) == "\t"))
         {
            trimmed = trimmed.substring(1);
         }
         var lower:String = trimmed.toLowerCase();
         // Match only the FIRST whitespace-delimited token so "/t trade", "/trade",
         // "/T  TRADING" etc. all switch channels (the user shouldn't have to type
         // the exact command alone).
         var tok:String = lower;
         var sp:int = lower.indexOf(" ");
         if(sp >= 0) { tok = lower.substring(0, sp); }
         // Vanilla-base fallback: the engine swallows the "/" key in the vanilla
         // chat field (it never reaches the TextField), so accept "." as an alias
         // prefix — ".g" behaves exactly like "/g". Normalize dot to slash here.
         if(tok.length > 1 && tok.charAt(0) == ".")
         {
            tok = "/" + tok.substring(1);
         }
         var slashTarget:int = -1; // 0=General 1=Trading 2=Events 3=Infests 4=Raids; -1=no match
         if(tok == "/general" || tok == "/gen" || tok == "/g")            { slashTarget = 0; }
         else if(tok == "/trading" || tok == "/trade" || tok == "/t")     { slashTarget = 1; }
         else if(tok == "/events"  || tok == "/event" || tok == "/e")     { slashTarget = 2; }
         else if(tok == "/infests" || tok == "/infest" || tok == "/inf" || tok == "/i")  { slashTarget = 3; }
         else if(tok == "/raids"   || tok == "/raid"  || tok == "/r")     { slashTarget = 4; }
         if(slashTarget >= 0)
         {
            this._fcmChannelIdx = slashTarget;
            this._fcmChannelId  = this.fcmChannelUuid(slashTarget);
            this.fcmPublishChannel();
            // "/g hello" switches to General AND sends "hello" there (classic chat
            // behavior). A bare "/g" just switches. The remainder falls through to
            // the normal send path below with the NEW channel id already set.
            var rest:String = "";
            if(sp >= 0)
            {
               rest = trimmed.substring(sp + 1);
            }
            while(rest.length > 0 && (rest.charAt(0) == " " || rest.charAt(0) == "\t"))
            {
               rest = rest.substring(1);
            }
            if(rest.length == 0)
            {
               return; // pure channel switch — nothing to send
            }
            Message = rest;
         }
         // Improvement 1: 225-char truncation before SEND.
         var cleaned:String = this.fcmClean(Message);
         if(cleaned.length > 225)
         {
            cleaned = cleaned.substring(0, 225);
         }
         // Diagnostic: log the cleaned text so slash/dot handling is verifiable in
         // zfe.log (fcmClean strips quotes/backslashes/tildes — JSON-log safe).
         this.fcmLog("info","send","forward len=" + cleaned.length + " raw=" + cleaned.substring(0, 40));
         if(this._fcmLegacy == null)
         {
            this._fcmLegacy = this.fcmFindBridge(this);
         }
         if(this._fcmLegacy == null)
         {
            this.fcmLog("warn","send","no bridge; cannot forward");
            return;
         }
         if(!this._fcmHelloSent)
         {
            this._fcmHelloSent = true;
            this.fcmSend("HELLO~" + this.fcmIdentity("account") + "~" + this.fcmIdentity("character") + "\n");
         }
         this.fcmSend("SEND~" + this._fcmChannelId + "~" + cleaned + "\n");
      }

      public function fcmIdentity(which:String) : String
      {
         var v:String = "Unknown";
         var a:* = null;
         try
         {
            if(which == "character")
            {
               if(this.CharacterInfoData && this.CharacterInfoData.name)
               {
                  v = String(this.CharacterInfoData.name);
               }
            }
            else
            {
               a = BSUIDataManager.GetDataFromClient("AccountInfoData");
               if(a && a.data && a.data.name)
               {
                  v = String(a.data.name);
               }
            }
         }
         catch(eId:Error)
         {
         }
         return this.fcmClean(v);
      }

      public function fcmSend(line:String) : void
      {
         if(this._fcmLegacy == null)
         {
            return;
         }
         try
         {
            this._fcmLegacy.call("writeUTFBytes",line);
            this.fcmLog("info","send","wrote " + line.length + "b");
         }
         catch(eSend:Error)
         {
            this.fcmLog("warn","send","writeUTFBytes threw");
         }
      }

      public function fcmClean(s:String) : String
      {
         if(s == null)
         {
            return "";
         }
         s = s.split("~").join("-");
         s = s.split("\r").join(" ");
         s = s.split("\n").join(" ");
         s = s.split("\"").join("'");
         s = s.split("\\").join("/");
         return s;
      }

      public function fcmLog(level:String, cat:String, msg:String) : void
      {
         // Path 1: socket DIAG line (independent of ZFE api; backend logs it to a file).
         if(this._fcmLegacy == null)
         {
            this._fcmLegacy = this.fcmFindBridge(this);
         }
         if(this._fcmLegacy != null)
         {
            try
            {
               this._fcmLegacy.call("writeUTFBytes","DIAG~" + cat + "~" + this.fcmClean(msg) + "\n");
            }
            catch(eDiag:Error)
            {
            }
         }
         // Path 2: ZFE log (if reachable from this context).
         if(this._fcmZfe == null)
         {
            this._fcmZfe = this.fcmFindZfe(this);
         }
         if(this._fcmZfe == null)
         {
            return;
         }
         // Improvement 2: apply fcmClean to msg before embedding in JSON to avoid
         // injection of quotes/backslashes that would break the JSON string.
         var safeMsg:String = this.fcmClean(msg);
         try
         {
            this._fcmZfe.call("log","{\"vendor\":\"HUDMenuChat\",\"level\":\"" + level + "\",\"category\":\"" + cat + "\",\"message\":\"" + safeMsg + "\"}");
         }
         catch(eLog:Error)
         {
         }
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
            if(z != null)
            {
               return z;
            }
         }
         catch(e0:Error)
         {
         }
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
                     try
                     {
                        z = child["__ZFE"];
                        if(z != null)
                        {
                           return z;
                        }
                     }
                     catch(eA:Error)
                     {
                     }
                     try
                     {
                        z = child["ZFECodeObj"];
                        if(z != null)
                        {
                           return z;
                        }
                     }
                     catch(eB:Error)
                     {
                     }
                     m = 0;
                     try
                     {
                        m = int(child.numChildren);
                     }
                     catch(eM:Error)
                     {
                     }
                     j = 0;
                     while(j < m)
                     {
                        try
                        {
                           gc = child.getChildAt(j);
                           z = gc["__ZFE"];
                           if(z != null)
                           {
                              return z;
                           }
                        }
                        catch(eJ:Error)
                        {
                        }
                        j = j + 1;
                     }
                  }
                  catch(eC:Error)
                  {
                  }
                  i = i + 1;
               }
            }
         }
         catch(eS:Error)
         {
         }
         return null;
      }

      public function fcmFindBridge(scope:*) : Object
      {
         var candidate:* = null;
         var nxt:* = null;
         var st:* = null;
         var child:* = null;
         var gc:* = null;
         var c2:* = null;
         var node:* = scope;
         var depth:int = 0;
         var n:int = 0;
         var m:int = 0;
         var i:int = 0;
         var j:int = 0;
         while(node != null && depth < 12)
         {
            candidate = this.fcmGetSF(node);
            if(candidate != null && this.fcmIsLegacy(candidate))
            {
               return candidate;
            }
            nxt = null;
            try
            {
               nxt = node.parent;
            }
            catch(eP:Error)
            {
            }
            if(nxt == node || nxt == null)
            {
               break;
            }
            node = nxt;
            depth = depth + 1;
         }
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
                     candidate = this.fcmGetSF(child);
                     if(candidate != null && this.fcmIsLegacy(candidate))
                     {
                        return candidate;
                     }
                     m = 0;
                     try
                     {
                        m = int(child.numChildren);
                     }
                     catch(eM:Error)
                     {
                     }
                     j = 0;
                     while(j < m)
                     {
                        try
                        {
                           gc = child.getChildAt(j);
                           c2 = this.fcmGetSF(gc);
                           if(c2 != null && this.fcmIsLegacy(c2))
                           {
                              return c2;
                           }
                        }
                        catch(eJ:Error)
                        {
                        }
                        j = j + 1;
                     }
                  }
                  catch(eC:Error)
                  {
                  }
                  i = i + 1;
               }
            }
         }
         catch(eS:Error)
         {
         }
         return null;
      }

      public function fcmGetSF(node:*) : Object
      {
         var v:* = null;
         try
         {
            v = node["__SFCodeObj"];
            if(v != null)
            {
               return v;
            }
         }
         catch(eG:Error)
         {
         }
         return null;
      }

      public function fcmIsLegacy(obj:*) : Boolean
      {
         var ret:* = null;
         try
         {
            if(obj.call == null)
            {
               return false;
            }
            ret = obj.call("__zfe_probe");
            if(ret == null)
            {
               return false;
            }
            if(ret is Boolean)
            {
               return ret == false;
            }
            if(String(ret).indexOf("unsupported_command") >= 0)
            {
               return false;
            }
            return true;
         }
         catch(eL:Error)
         {
         }
         return false;
      }

      // Improvement 8: input length feedback — called from chatEntryKeyUp hook.
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
            if(tf.length > 215)
            {
               tf.textColor = 0xFF4444; // red — approaching limit
            }
            else
            {
               tf.textColor = 0xF5CB5B; // amber — normal
            }
            // Diagnostic (vanilla-base slash investigation): fires on every keyUp in
            // chat mode. Logs whether a leading "/" actually landed in the field —
            // distinguishes "engine ate the / key" from "ENTER suppressed on /-text".
            var t:String = String(tf.text);
            if(t.length > 0 && t.charAt(0) == "/")
            {
               this.fcmLog("info","type","slash-in-field len=" + t.length);
            }
         }
         catch(eCk:Error)
         {
         }
      }
