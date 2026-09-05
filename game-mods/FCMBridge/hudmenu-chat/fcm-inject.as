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
         this._fcmLogger = this.fcmFindGenericCallback(this);
         this.fcmLog("info","load","hudmenu-init zfe=" + (this._fcmZfe != null));
         this.fcmApplyIniDefaults();
         this._fcmNavigationDown = [];
         this._fcmNavigationAction = "";
         if(!this._fcmModernWidgetActive)
         {
            // Standalone variant: give HUDModLoader time to instantiate the modern
            // FCMChatWidget before falling back to the legacy renderer. The old
            // immediate fallback raced the loader and painted an untagged duplicate
            // feed beside the modern row-local widget.
            this.fcmScheduleStandaloneFallback();
            // Feed worldId + player name to the bridge every 5 s from HUDMenu scope
            // (server chat join/leave rides this — see fcmPollWorldId).
            // Uses the flash.utils.Timer CLASS (proven under Scaleform/GFx — FCMBridge
            // uses it throughout). Do NOT use flash.utils.setInterval here: it is a
            // package-level function outside GFx's AS3 subset and verify-kills fcmInit.
            try
            {
               this._fcmWorldTimer = new flash.utils.Timer(5000);
               this._fcmWorldTimer.addEventListener("timer", this.fcmOnWorldTick);
               this._fcmWorldTimer.start();
            }
            catch(eWt:Error)
            {
               this.fcmLog("warn","world","world timer setup threw: " + eWt.message);
            }
         }
      }

      // ProcessUserEvent / HUDMenu construction are engine-owned callback boundaries.
      // Keep the injected helpers fail-closed so a target-build exception cannot bubble into
      // the game's global UncaughtErrorEvent handler and strand the player in a modal state.
      public function fcmInitSafe() : void
      {
         try { this.fcmInit(); }
         catch(eInit:Error)
         {
            try { this.fcmLog("warn","load","fcmInit threw: " + eInit.message); }
            catch(eLog:Error) {}
         }
      }

      // Timer tick — TimerEvent handler shape (evt:*) so no TimerEvent import is needed.
      public function fcmOnWorldTick(evt:*) : void
      {
         try { this.fcmPollWorldId(); }
         catch(eP:Error)
         {
            this.fcmLog("warn","world","fcmPollWorldId threw: " + eP.message);
         }
      }

      // HUDModLoader's modern FCMChatWidget calls this as soon as it reaches the
      // stage. Claim renderer ownership immediately instead of waiting for the
      // five-second world timer to notice the child. The old FCMBridge renderer
      // produces the untagged duplicate row, so it must be retired before the
      // modern widget can receive its first message.
      public function fcmNotifyModernWidget(widget:*) : void
      {
         this._fcmModernWidgetActive = true;
         try
         {
            if(this._fcmSelfLoadTimer != null) { this._fcmSelfLoadTimer.stop(); }
         }
         catch(eStopFallback:Error) {}
         this._fcmSelfLoadTimer = null;
         try
         {
            if(this._fcmWorldTimer != null) { this._fcmWorldTimer.stop(); }
         }
         catch(eStopWorld:Error) {}
         this._fcmWorldTimer = null;

         var legacy:* = this._fcmBridge;
         if(legacy == null)
         {
            try { legacy = this.fcmFindLegacyBridge(this.stage, 0); }
            catch(eFindLegacy:Error) { legacy = null; }
         }
         if(legacy != null)
         {
            try { legacy.fcmDisableForModernWidget(); }
            catch(eDisableLegacy:Error)
            {
               this.fcmLog("warn","selfload","legacy renderer handoff threw: " + eDisableLegacy.message);
            }
         }
         this._fcmBridge = null;
         this.fcmLog("info","selfload","modern FCMChatWidget claimed renderer");
      }

      // Pass the native chat bridge we hold at the HUDMenu (parent) level down
      // to the FCMBridge child SWF. ZFE and xScal both attach their bridge to
      // the parent movie, while child SWFs may not inherit it.
      // Sharing it here lets FCMBridge connect even without HUDModLoader.
      public function fcmPassZfeToBridge() : void
      {
         if(this._fcmBridge == null) { return; }
         try
         {
            // Keep provider identities separate. xScal exposes chatInterface
            // under __SFECodeObj in some builds and directly under __SFCodeObj
            // in others. A bare __SFCodeObj.call is not a ZFE object.
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
               try { hostZfe = this["ZFECodeObj"]; } catch(e3:Error) {}
            }
            if(hostZfe == null)
            {
               try { if(this.parent != null) { hostZfe = this.parent["ZFECodeObj"]; } } catch(e4:Error) {}
            }
            if(hostZfe == null)
            {
               try { if(this.root != null) { hostZfe = this.root["ZFECodeObj"]; } } catch(e5:Error) {}
            }
            if(hostZfe == null)
            {
               try { hostZfe = ZFECodeObj; } catch(e6:Error) {}
            }

            var hostXscal:* = null;
            try { hostXscal = this["__SFECodeObj"]; } catch(eX0:Error) {}
            if(hostXscal == null)
            {
               try { if(this.parent != null) { hostXscal = this.parent["__SFECodeObj"]; } } catch(eX1:Error) {}
            }
            if(hostXscal == null)
            {
               try { if(this.root != null) { hostXscal = this.root["__SFECodeObj"]; } } catch(eX2:Error) {}
            }
            // Some xScal builds attach chatInterface directly to __SFCodeObj.
            // Only classify that slot as xScal when the explicit chat surface
            // exists; a generic call-only object remains legacy/ambiguous.
            if(hostXscal == null)
            {
               try {
                  var hostSfChat0:* = this["__SFCodeObj"];
                  if(hostSfChat0 != null && hostSfChat0["chatInterface"] != null) { hostXscal = hostSfChat0; }
               } catch(eX3:Error) {}
            }
            if(hostXscal == null)
            {
               try {
                  var hostSfChat1:* = this.parent != null ? this.parent["__SFCodeObj"] : null;
                  if(hostSfChat1 != null && hostSfChat1["chatInterface"] != null) { hostXscal = hostSfChat1; }
               } catch(eX4:Error) {}
            }
            if(hostXscal == null)
            {
               try {
                  var hostSfChat2:* = this.root != null ? this.root["__SFCodeObj"] : null;
                  if(hostSfChat2 != null && hostSfChat2["chatInterface"] != null) { hostXscal = hostSfChat2; }
               } catch(eX5:Error) {}
            }
            var hostLogger:* = null;
            if(hostXscal != null)
            {
               // xScal chatInterface and its generic diagnostic callback are
               // separate surfaces on most builds. Pass the latter only as a
               // logger; FCMBridge never routes chat.v1 verbs through it.
               hostLogger = this.fcmFindGenericCallback(this);
            }
            // An explicit xScal chatInterface is the strongest provider signal.
            // ZFE and xScal may be co-installed and expose objects on the same
            // HUDMenu; ZFE must not win just because __ZFE is checked first.
            var hostNative:* = hostXscal;
            var provider:String = (hostXscal != null) ? "xscal" : "";
            if(hostNative == null)
            {
               hostNative = hostZfe;
               provider = (hostNative != null) ? "zfe" : "";
            }

            // __SFCodeObj is a last-resort legacy compatibility candidate.
            // FcmNativeApi positively probes it before accepting it as ZFE, so
            // xScal's generic callback surface cannot receive chat.v1 calls.
            if(hostNative == null)
            {
               try { hostNative = this["__SFCodeObj"]; } catch(eL0:Error) {}
               if(hostNative == null)
               {
                  try { if(this.parent != null) { hostNative = this.parent["__SFCodeObj"]; } } catch(eL1:Error) {}
               }
               if(hostNative == null)
               {
                  try { if(this.root != null) { hostNative = this.root["__SFCodeObj"]; } } catch(eL2:Error) {}
               }
               if(hostNative == null)
               {
                  try { hostNative = __SFCodeObj; } catch(eL3:Error) {}
               }
               provider = (hostNative != null) ? "legacy" : "";
            }
            var found:String = (hostNative != null) ? "found" : "absent";
            this.fcmLog("info","native","provider=" + provider + " bridge=" + found);
            if(hostNative != null)
            {
               try { this._fcmBridge.fcmSetNativeApi(hostNative, provider, hostLogger); }
               catch(eSet:Error)
               {
                  this.fcmLog("warn","native","fcmSetNativeApi threw: " + eSet.message);
               }
            }
         }
         catch(ePass:Error)
         {
            this.fcmLog("warn","zfe","fcmPassZfeToBridge threw: " + ePass.message);
         }
      }

      // HUDModLoader may load FCMChatWidget asynchronously. Give it a grace
      // period before the standalone legacy fallback is allowed to load.
      private function fcmScheduleStandaloneFallback() : void
      {
         if(this._fcmSelfLoadTimer != null) { return; }
         try
         {
            this._fcmSelfLoadTimer = new flash.utils.Timer(8000, 1);
            this._fcmSelfLoadTimer.addEventListener("timerComplete", this.fcmOnStandaloneFallback);
            this._fcmSelfLoadTimer.start();
            this.fcmLog("info","selfload","legacy fallback delayed 8s for HUDModLoader");
         }
         catch(eSchedule:Error)
         {
            this._fcmSelfLoadTimer = null;
            this.fcmLog("warn","selfload","fallback timer setup threw: " + eSchedule.message);
            try { if(!this.fcmStageHasChatWidget()) { this.fcmSelfLoadBridge(); } }
            catch(eFallback:Error) { this.fcmLog("warn","selfload","fallback launch threw: " + eFallback.message); }
         }
      }

      public function fcmOnStandaloneFallback(evt:*) : void
      {
         this._fcmSelfLoadTimer = null;
         try
         {
            if(this.fcmStageHasChatWidget())
            {
               this.fcmLog("info","selfload","FCMChatWidget appeared — legacy fallback cancelled");
               return;
            }
            this.fcmSelfLoadBridge();
         }
         catch(eFallback:Error)
         {
            this.fcmLog("warn","selfload","standalone fallback threw: " + eFallback.message);
         }
      }

      // Find the legacy bridge through Loader/content wrappers as well as a
      // direct stage child. Do not treat the modern widget as a bridge.
      private function fcmFindLegacyBridge(node:*, depth:int) : *
      {
         if(node == null || depth > 8) { return null; }
         try { if(Boolean(node["fcmChatWidgetMarker"])) { return null; } }
         catch(eMarker:Error) {}
         try { if(node["fcmSendMessage"] != null) { return node; } }
         catch(eMethod:Error) {}
         var n:int = 0;
         try { n = int(node.numChildren); } catch(eCount:Error) { return null; }
         for(var i:int = 0; i < n; i++)
         {
            try
            {
               var found:* = this.fcmFindLegacyBridge(node.getChildAt(i), depth + 1);
               if(found != null) { return found; }
            }
            catch(eChild:Error) {}
         }
         return null;
      }

      // Self-load FCMBridge.swf into the HUD when HUDModLoader is NOT present.
      // Uses flash.display.Loader (SWF loader — works in GFx) NOT URLLoader
      // (data loader — sandbox-blocked in GFx). Shares ApplicationDomain so
      // FCMBridge lands in the same domain and fcmFindBridge can find it.
      // CONDITIONAL: bails out immediately if the bridge is already present.
      public function fcmSelfLoadBridge() : void
      {
         // HUDModLoader may place FCMChatWidget below its loader root rather than as a direct
         // stage child. Detect the widget by its stable marker before loading the legacy feed;
         // stage-name-only detection allowed both renderers to run and duplicated every send.
         if(this.fcmStageHasChatWidget())
         {
            this.fcmLog("info","selfload","FCMChatWidget present — skip legacy FCMBridge self-load");
            return;
         }
         // Scan through Loader/content wrappers for an existing legacy bridge.
         try
         {
            var existing:* = this.fcmFindLegacyBridge(this.stage, 0);
            if(existing != null)
            {
               this.fcmLog("info","selfload","FCMBridge child found — skip self-load");
               this._fcmBridge = existing;
               this.fcmPassZfeToBridge();
               return;
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

      public function fcmStageHasChatWidget() : Boolean
      {
         if(this._fcmModernWidgetActive) { return true; }
         try
         {
            return this.fcmDisplayTreeHasChatWidget(this.stage, 0);
         }
         catch(eWidgetScan:Error)
         {
            this.fcmLog("warn","selfload","chat widget scan threw: " + eWidgetScan.message);
         }
         return false;
      }

      // Return the actual modern widget, not just its marker. ProcessUserEvent runs before
      // HUDMenu dispatches HUDMod::UserEvent, so the host can give the widget first refusal and
      // set the function's consumed return value. That is the only reliable way to stop vanilla
      // TeamChat from opening a second editor after SharedHUDTools already owns the focus.
      private function fcmFindChatWidget(node:*, depth:int) : *
      {
         if(node == null || depth > 8) { return null; }
         var sn:String = "";
         try { sn = String(node.name); } catch(eName:Error) {}
         try
         {
            if(sn == "FCMChatWidget" || Boolean(node["fcmChatWidgetMarker"])) { return node; }
         }
         catch(eMarker:Error) {}
         var n:int = 0;
         try { n = int(node.numChildren); } catch(eCount:Error) { return null; }
         for(var i:int = 0; i < n; i++)
         {
            try
            {
               var child:* = node.getChildAt(i);
               var found:* = this.fcmFindChatWidget(child, depth + 1);
               if(found != null) { return found; }
            }
            catch(eChild:Error) {}
         }
         return null;
      }

      private function fcmDisplayTreeHasChatWidget(node:*, depth:int) : Boolean
      {
         if(node == null || depth > 8) { return false; }
         var sn:String = "";
         try { sn = String(node.name); } catch(eName:Error) {}
         if(sn == "FCMChatWidget") { return true; }
         try { if(Boolean(node["fcmChatWidgetMarker"])) { return true; } } catch(eMarker:Error) {}
         var n:int = 0;
         try { n = int(node.numChildren); } catch(eCount:Error) { return false; }
         for(var i:int = 0; i < n; i++)
         {
            try { if(this.fcmDisplayTreeHasChatWidget(node.getChildAt(i), depth + 1)) return true; }
            catch(eChild:Error) {}
         }
         return false;
      }

      // Called when FCMBridge.swf finishes loading (standalone path only).
      public function fcmOnBridgeLoaded(evt:*) : void
      {
         if(this._fcmModernWidgetActive)
         {
            // A Loader request may already be in flight when HUDModLoader wins
            // the race. Re-scan and retire that late legacy child as well.
            this.fcmNotifyModernWidget(null);
            return;
         }
         this.fcmLog("info","selfload","FCMBridge.swf load complete — re-scanning for bridge");
         try
         {
            var found:* = this.fcmFindLegacyBridge(this.stage, 0);
            if(found != null)
            {
               this._fcmBridge = found;
               this.fcmLog("info","selfload","bridge found after self-load OK");
               this.fcmPassZfeToBridge();
               return;
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
         this._fcmIniOpenKey = "INSERT";
         this._fcmIniLoaded = true;
         // Default channel index (0 = global).
         this._fcmChannelIdx = 0;
         this._fcmChannelSlug = "global";
      }

      // Channel slug table — 0-4 map GENERAL/TRADING/EVENTS/INFESTS/RAIDS;
      // 5 = "server" (the worldId-bound room), selectable ONLY while in a world.
      // Slugs MUST match AllowedChannels in Data/ZFE/TextChat/fragments/FCM.ini.
      public function fcmChannelSlug(idx:int) : String
      {
         if(idx == 1) { return "trade"; }
         if(idx == 2) { return "events"; }
         if(idx == 3) { return "infests"; }
         if(idx == 4) { return "raids"; }
         if(idx == 5) { return "server"; }
         return "global";
      }

      public function fcmChannelName(idx:int) : String
      {
         if(idx == 1) { return "Trading"; }
         if(idx == 2) { return "Events"; }
         if(idx == 3) { return "Infests"; }
         if(idx == 4) { return "Raids"; }
         if(idx == 5) { return "Server"; }
         return "General";
      }

      // True while the player is in a world — FCMBridge tracks it off the worldId
      // this file feeds it (fcmPollWorldId). Gates the SERVER channel (index 5).
      public function fcmInWorldNow() : Boolean
      {
         if(this._fcmBridge == null) { return false; }
         try { return Boolean(this._fcmBridge.fcmInWorld()); }
         catch(eIw:Error) {}
         return false;
      }

      // Poll worldId + player name from BSUIDataManager IN HUDMENU SCOPE and feed
      // them to FCMBridge. This is the authoritative read: BSUIDataManager is
      // guaranteed reachable here (vanilla HUDMenu itself subscribes to it), while
      // a child-SWF read can fail with ReferenceError (the widget variant proved
      // this — it always fell back to "Wanderer" and an empty worldId).
      // Stateless on purpose: FCMBridge dedupes; empty worldId = "left the world".
      public function fcmPollWorldId() : void
      {
         // If HUDModLoader appeared after the standalone fallback, retire the
         // legacy renderer before it can consume another poll or paint another row.
         if(this.fcmStageHasChatWidget())
         {
            if(this._fcmSelfLoadTimer != null)
            {
               try { this._fcmSelfLoadTimer.stop(); } catch(eStopFallback:Error) {}
               this._fcmSelfLoadTimer = null;
            }
            if(this._fcmBridge != null)
            {
               try { this._fcmBridge.fcmDisableForModernWidget(); } catch(eDisable:Error) {}
               this._fcmBridge = null;
            }
            return;
         }
         if(this._fcmBridge == null) { return; }
         // Late __ZFE handover: ZFE attaches to the HUD movie AFTER fcmInit ran,
         // so the load-time fcmPassZfeToBridge can miss it. Re-find on this tick
         // and pass it down once found (fcmSetZfe is once-guarded bridge-side).
         if(this._fcmZfe == null)
         {
            this._fcmZfe = this.fcmFindZfe(this);
            if(this._fcmZfe != null)
            {
               this.fcmLog("info","zfe","late __ZFE find on world tick — passing to bridge");
               this.fcmPassZfeToBridge();
            }
         }
         var wid:String = "";
         var pname:String = "";
         try
         {
            var a:* = BSUIDataManager.GetDataFromClient("AccountInfoData");
            if(a != null && a.data != null)
            {
               try { if(a.data.worldId != null) { wid = String(a.data.worldId); } } catch(eW:Error) {}
               try { if(a.data.name != null) { pname = String(a.data.name); } } catch(eN:Error) {}
            }
         }
         catch(eAcc:Error) {}
         try { if(pname.length > 0) { this._fcmBridge.fcmSetPlayerName(pname); } } catch(eSetN:Error) {}
         try { this._fcmBridge.fcmSetWorldId(wid); } catch(eSetW:Error) {}
         // If we left the world while the SERVER tab was active, fall back to GENERAL
         // (the bridge already snapped its own index; keep this side in sync).
         if(wid.length == 0 && this._fcmChannelIdx == 5)
         {
            this._fcmChannelIdx = 0;
            this._fcmChannelSlug = "global";
            this.fcmPublishChannel();
         }
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

      // Cycle the active channel in DISPLAY order. In a world, SERVER sits right
      // of GENERAL: General -> Server -> Trading -> Events -> Infests -> Raids.
      // Out of a world SERVER is skipped entirely.
      // Triggered by the NextPage control-map action (Page Down) or its physical alias.
      public function fcmSwitchChannel() : void
      {
         var order:Array = this.fcmInWorldNow() ? [0,5,1,2,3,4] : [0,1,2,3,4];
         var pos:int = order.indexOf(this._fcmChannelIdx);
         if(pos < 0) { pos = 0; }
         this._fcmChannelIdx = int(order[(pos + 1) % order.length]);
         this._fcmChannelSlug = this.fcmChannelSlug(this._fcmChannelIdx);
         this.fcmPublishChannel();
      }

      // Page Up uses the same display order as Page Down, but travels in the
      // opposite direction. Keep this helper in HUDMenu itself: the patched
      // host must not call a method that exists only on FCMBridge.
      public function fcmSwitchChannelPrev() : void
      {
         var order:Array = this.fcmInWorldNow() ? [0,5,1,2,3,4] : [0,1,2,3,4];
         var pos:int = order.indexOf(this._fcmChannelIdx);
         if(pos < 0) { pos = 0; }
         this._fcmChannelIdx = int(order[(pos + order.length - 1) % order.length]);
         this._fcmChannelSlug = this.fcmChannelSlug(this._fcmChannelIdx);
         this.fcmPublishChannel();
      }

      // HUDMenu receives aliases with different spelling across loader/game builds. Normalize
      // only the named action token; this never touches the focused TextField's characters.
      private function fcmNormalizeAction(action:String) : String
      {
         if(action == null) { return ""; }
         var normalized:String = action.toLowerCase();
         normalized = normalized.split(" ").join("");
         normalized = normalized.split("_").join("");
         normalized = normalized.split("-").join("");
         return normalized;
      }

      public function fcmEvent(action:String, pressed:Boolean) : Boolean
      {
         // HUDModLoader's modern widget receives the same bubbling event before
         // HUDMenu.ProcessUserEvent. Let it handle the event BEFORE vanilla dispatches the
         // bubbling copy. The widget records that host-handled edge and ignores the later copy,
         // preventing Page actions from switching twice and TeamChat from opening a second
         // editor. A false result deliberately lets vanilla keep ordinary gameplay/external
         // modal actions.
         if(this.fcmStageHasChatWidget())
         {
            try
            {
               var modern:* = this.fcmFindChatWidget(this.stage, 0);
               if(modern != null)
               {
                  var modernHandler:* = modern["fcmHandleHostUserEvent"];
                  if(modernHandler != null)
                  {
                     return Boolean(Reflect.callMethod(modern, modernHandler, [action, pressed]));
                  }
               }
            }
            catch(eModern:Error)
            {
               this.fcmLog("warn","event","modern host event threw: " + eModern.message);
            }
            return false;
         }
         var normalized:String = this.fcmNormalizeAction(action);
         // Chat-open hotkey: INSERT (matches the shipped OpenChatKey in FCM.ini).
         // Also accept TeamChat and Console (legacy) as aliases. Open on key-UP only so the
         // opening action never leaks a character into the newly focused native field.
         var openKey:String = (this._fcmIniOpenKey != null && this._fcmIniOpenKey.length > 0) ? this._fcmIniOpenKey : "INSERT";
         if((action == openKey || action == "Console" || action == "ConsoleToggles" || action == "TeamChat") && !pressed)
         {
            this.fcmLog("info","open",action + " -> enterChatMode");
            this.fcmResetNavigation();
            try
            {
               this.enterChatMode();
               this.fcmStyleInput();
               // Do not announce an input session until the host editor setup completed. A
               // failed open must leave arrows/page actions and typed characters to the game.
               this._fcmInputActive = true;
            }
            catch(eOpen:Error)
            {
               this._fcmInputActive = false;
               this.fcmResetNavigation();
               this.fcmLog("warn","open","enterChatMode threw: " + eOpen.message);
            }
            return this._fcmInputActive;
         }
         // Loader builds differ: some emit both edges and some only emit key-UP. Handle the
         // first edge available and ignore the matching second edge. Page actions are one-shot
         // channel commands; there is no persistent channel-selection mode.
         var isNextPage:Boolean = normalized == "nextpage" || normalized == "pagedown";
         var isPrevPage:Boolean = normalized == "prevpage" || normalized == "pageup";
         var isFeedNav:Boolean = normalized == "up" || normalized == "arrowup" || normalized == "cursorup"
            || normalized == "down" || normalized == "arrowdown" || normalized == "cursordown"
            || normalized == "home" || normalized == "end";
         if(isNextPage || isPrevPage || isFeedNav)
         {
            var navigationWasDown:Boolean = this.fcmNavigationIsDown(normalized);
            if(pressed)
            {
               if(navigationWasDown) { return true; }
               this.fcmNavigationMarkDown(normalized);
            }
            else if(navigationWasDown)
            {
               this.fcmNavigationClear(normalized);
               return true;
            }

            if(isNextPage)
            {
               this.fcmSwitchChannel();
               return true;
            }
            if(isPrevPage)
            {
               this.fcmSwitchChannelPrev();
               return true;
            }
            // Feed navigation is unlocked only after Insert successfully opens the native chat
            // editor. Before that, arrows remain ordinary game controls.
            if(this._fcmInputActive && this._fcmBridge != null)
            {
               if(normalized == "up" || normalized == "arrowup" || normalized == "cursorup")
               {
                  try { this._fcmBridge.fcmScrollUp(); } catch(eSu:Error) {}
                  return true;
               }
               if(normalized == "down" || normalized == "arrowdown" || normalized == "cursordown")
               {
                  try { this._fcmBridge.fcmScrollDown(); } catch(eSd:Error) {}
                  return true;
               }
               if(normalized == "home" || normalized == "end")
               {
                  try { this._fcmBridge.fcmScrollToBottom(); } catch(eSb:Error) {}
                  return true;
               }
            }
            // The action was a feed command, but FCM does not own navigation until Insert has
            // opened a live editor. Let the game retain its normal arrow controls in that state.
            return false;
         }
         // Suppress noisy repeated / high-frequency actions.
         if(action == "Console" || action == "ConsoleToggles" || action == "Unmapped" || action == "DISABLED")
         {
            return false;
         }
         if(action == "Forward" || action == "Back" || action == "StrafeLeft" || action == "StrafeRight" || action == "Move" || action == "Look" || action == "Turn" || action == "Melee" || action == "ReadyWeapon" || action == "Attack" || action == "Run" || action == "Sprint" || action == "Jump" || action == "Ping" || action == "Activate" || action == "Sneak" || action == "ToggleRun" || action == "AutoMove")
         {
            return false;
         }
         if(this._fcmLastEvent == action) { return false; }
         this._fcmLastEvent = action;
         this.fcmLog("info","event",action + "~" + pressed);
         return false;
      }

      public function fcmEventSafe(action:String, pressed:Boolean) : Boolean
      {
         try { return this.fcmEvent(action, pressed); }
         catch(eEvent:Error)
         {
            try { this.fcmLog("warn","event","fcmEvent threw: " + eEvent.message); }
            catch(eLog:Error) {}
            return false;
         }
      }

      private function fcmResetNavigation() : void
      {
         this._fcmNavigationDown = [];
         this._fcmNavigationAction = "";
      }

      private function fcmNavigationIsDown(key:String) : Boolean
      {
         if(this._fcmNavigationDown == null) { this._fcmNavigationDown = []; }
         return this._fcmNavigationDown.indexOf(key) >= 0;
      }

      private function fcmNavigationMarkDown(key:String) : void
      {
         if(this._fcmNavigationDown == null) { this._fcmNavigationDown = []; }
         if(this._fcmNavigationDown.indexOf(key) < 0) { this._fcmNavigationDown.push(key); }
         this._fcmNavigationAction = key;
      }

      private function fcmNavigationClear(key:String) : void
      {
         if(this._fcmNavigationDown == null) { this._fcmNavigationDown = []; }
         var idx:int = this._fcmNavigationDown.indexOf(key);
         if(idx >= 0) { this._fcmNavigationDown.splice(idx, 1); }
         if(this._fcmNavigationDown.length == 0) { this._fcmNavigationAction = ""; }
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
         // FCMChatWidget's SharedHUDTools callback already submits this message.
         // The original HUDMenu send hook still fires on some loader builds; do
         // not forward that same text through the legacy bridge a second time.
         if(this.fcmStageHasChatWidget())
         {
            this.fcmLog("info","send","modern widget owns submit; legacy forward skipped");
            return;
         }
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
         else if(tok == "/server"  || tok == "/s")                       { slashTarget = 5; }
         // SERVER exists only while in a world — refuse the switch (consume the input).
         if(slashTarget == 5 && !this.fcmInWorldNow())
         {
            this.fcmLog("info","chan","/server refused — not in a world");
            this.fcmShowAuthHint("Server chat is only available while in a world");
            return;
         }
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
               this._fcmBridge = this.fcmFindLegacyBridge(this.stage, 0);
               if(this._fcmBridge != null) { this.fcmPassZfeToBridge(); }
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

      public function fcmForwardSafe(Message:String) : void
      {
         try { this.fcmForward(Message); }
         catch(eForward:Error)
         {
            try { this.fcmLog("warn","send","fcmForward threw: " + eForward.message); }
            catch(eLog:Error) {}
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
         if(this._fcmLogger == null) { this._fcmLogger = this.fcmFindGenericCallback(this); }
         var logger:* = this._fcmZfe != null ? this._fcmZfe : this._fcmLogger;
         if(logger == null) { return; }
         var safeMsg:String = this.fcmClean(msg);
         try
         {
            logger.call("log","{\"vendor\":\"HUDMenuChat\",\"level\":\"" + level + "\",\"category\":\"" + cat + "\",\"message\":\"" + safeMsg + "\"}");
         }
         catch(eLog:Error) {}
      }

      // xScal's __SFCodeObj.call is a diagnostic callback registry, not the
      // chat transport. Find it for log forwarding without ever making it a
      // provider candidate on its own.
      public function fcmFindGenericCallback(scope:*) : Object
      {
         var cur:* = scope;
         var depth:int = 0;
         while(cur != null && depth < 25)
         {
            try
            {
               var candidate:* = cur["__SFCodeObj"];
               if(candidate != null && candidate.call != null) { return candidate; }
            }
            catch(eCandidate:Error) {}
            try { cur = cur.parent; }
            catch(eParent:Error) { cur = null; }
            depth = depth + 1;
         }
         try
         {
            var stage:* = scope.stage;
            if(stage != null && stage != scope)
            {
               var stageCandidate:* = stage["__SFCodeObj"];
               if(stageCandidate != null && stageCandidate.call != null) { return stageCandidate; }
            }
         }
         catch(eStage:Error) {}
         try
         {
            var root:* = scope.root;
            if(root != null && root != scope)
            {
               var rootCandidate:* = root["__SFCodeObj"];
               if(rootCandidate != null && rootCandidate.call != null) { return rootCandidate; }
            }
         }
         catch(eRoot:Error) {}
         return null;
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
