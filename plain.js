/**
 * A plain Annotorious Annotator that can draw Rectangles.  It is able to draw Polygons, but this ability is not exposed to the user.
 * It assigns all Annotations to one AnnotationPage (does not make or track more than one page at a time)
 *
 * It is exposed to the user at index.html?iiif-content=theid.  The id is the URI of a Canvas or of an AnnotationPage.
 * Saving creates or overwrites that AnnotationPage through TinyNode.
 *
 * The Annotation generation UI is powered by Annotorious.  The TPEN3 team hereby acknowledges
 * and thanks the Annotorious development team for this open source software.
 * @see https://annotorious.dev/
 * Annotorious licensing information can be found at https://github.com/annotorious/annotorious
 * @element simple-canvas-annotator
*/

// The TinyNode that saves through to RERUM.  Swap for this app's own TinyNode instance.
const TINY_URL = "https://tinydev.rerum.io"
// The creator of the AnnotationPages and Annotations this app mints, so its data can be found, even in the sandbox.
// A Canvas also uses it to find its own page and not another tool's.
const CREATOR = "simple-canvas-annotator"
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" }

class AnnotoriousAnnotator extends HTMLElement {
    #osd
    #annotoriousInstance
    #contentURI
    #resolvedAnnotationPage
    #canvasID
    /** @type {Array} AnnotationPage items with no xywh selector.  They are not drawn but are kept when saving. */
    #undrawableItems = []
    #imageDims
    #canvasDims
    #isDrawing = false
    #isErasing = false
    /** @type {number|null} Timeout ID for erase confirmation */
    #eraseConfirmTimeout = null
    /** @type {AbortController|null} Aborting removes the tool event listeners */
    #listenerController = null
    /** @type {Promise|null} Resolves once OpenSeadragon and Annotorious are loaded from the CDN */
    #librariesLoaded = null

    static get observedAttributes() {
      return ["iiif-content"]
    }

    constructor() {
      super()
      this.attachShadow({ mode: 'open' })
    }

    connectedCallback() {
      this.render()
      this.addEventListeners()
      this.initAnnotator()
    }

    render() {
      const osdScript = document.createElement("script")
      osdScript.src = "https://cdn.jsdelivr.net/npm/openseadragon@latest/build/openseadragon/openseadragon.min.js"
      const annotoriousScript = document.createElement("script")
      annotoriousScript.src = "https://cdn.jsdelivr.net/npm/@annotorious/openseadragon@latest/dist/annotorious-openseadragon.js"
      // Annotorious needs the OpenSeadragon global when it executes.  Injected scripts are async by default.
      osdScript.async = false
      annotoriousScript.async = false
      this.#librariesLoaded = new Promise((resolve, reject) => {
        annotoriousScript.addEventListener("load", resolve, { once: true })
        annotoriousScript.addEventListener("error", reject, { once: true })
      })

      this.shadowRoot.innerHTML = `
        <style>
          @import url("https://cdn.jsdelivr.net/npm/@annotorious/openseadragon@latest/dist/annotorious-openseadragon.css");
          #annotator-container {
            height:  100vh;
          }
          /* Saved selectors are xywh, which cannot hold a rotation, so rectangles are not rotatable. */
          .a9s-rotation-handle-group, .a9s-rotation-handle {
            display: none;
          }
          #tools-container {
            background-color: lightgray;
            position: absolute;
            top: 4em;
            z-index: 10;
          }
        </style>
        <div>
            <div id="tools-container">
              <p> You can zoom and pan when you are not drawing.</p>
              <label for="drawTool">Draw Mode
               <input  type="checkbox" id="drawTool">
              </label>
              <br>
              <label> Erase Mode
               <input type="checkbox" id="eraseTool">
              </label>
              <br>
              <label> Annotation Visibility
               <input type="checkbox" id="seeTool" checked>
              </label>
              <br>
              <input id="saveBtn" type="button" value="Save Annotations"/>
              <p id="status" role="status"></p>
            </div>
            <div id="annotator-container"></div>
        </div>

        `
      this.shadowRoot.appendChild(osdScript)
      this.shadowRoot.appendChild(annotoriousScript)
    }

    addEventListeners() {
      const drawTool = this.shadowRoot.getElementById("drawTool")
      const eraseTool = this.shadowRoot.getElementById("eraseTool")
      const seeTool = this.shadowRoot.getElementById("seeTool")
      const saveButton = this.shadowRoot.getElementById("saveBtn")

      const drawHandler = (e) => this.toggleDrawingMode(e)
      const eraseHandler = (e) => this.toggleErasingMode(e)
      const seeHandler = (e) => this.toggleAnnotationVisibility(e)
      const saveHandler = (e) => this.saveAnnotations(e)

      this.#listenerController = new AbortController()
      const { signal } = this.#listenerController
      drawTool.addEventListener('change', drawHandler, { signal })
      eraseTool.addEventListener('change', eraseHandler, { signal })
      seeTool.addEventListener('change', seeHandler, { signal })
      saveButton.addEventListener('click', saveHandler, { signal })
    }

    disconnectedCallback() {
      // Clear any pending erase confirmation timeout
      if (this.#eraseConfirmTimeout) {
        clearTimeout(this.#eraseConfirmTimeout)
        this.#eraseConfirmTimeout = null
      }
      this.#listenerController?.abort()
    }

    initAnnotator() {
      this.#contentURI = new URLSearchParams(window.location.search).get('iiif-content')
      if(!this.#contentURI) {
          this.showMessage("You must provide a ?iiif-content=theid in the URL.  The value should be the URI of an existing Canvas or AnnotationPage.")
          return
      }
      this.setAttribute("iiif-content", this.#contentURI)
    }

    /**
     * Show a status message to the user in the tools panel.
     * @param {string} message
    */
    showMessage(message) {
      this.shadowRoot.getElementById("status").textContent = message
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if(newValue === oldValue || !newValue) return
      if(name === 'iiif-content') {
          this.processContent(newValue).catch(err => {
            console.error(err)
            this.showMessage(err.message)
          })
      }
    }

    /**
     * Renders the canvas with OpenSeadragon and Annotorious.
     * @param {Object} resolvedCanvas - The resolved Canvas object
     */
    async renderCanvas(resolvedCanvas) {
      await this.#librariesLoaded
      this.shadowRoot.getElementById('annotator-container').innerHTML = ""
      const canvasID = resolvedCanvas["@id"] ?? resolvedCanvas.id
      this.#canvasID = canvasID
      const fullImage = resolvedCanvas?.items[0]?.items[0]?.body?.id
      let imageService = resolvedCanvas?.items[0]?.items[0]?.body?.service?.id

      if(!fullImage) {
          throw new Error("Cannot Resolve Canvas Image",
            {"cause":"The Image is 404 or unresolvable."})
      }

      this.#imageDims = [
        resolvedCanvas?.items[0]?.items[0]?.body?.width,
        resolvedCanvas?.items[0]?.items[0]?.body?.height
      ]
      this.#canvasDims = [
        resolvedCanvas?.width,
        resolvedCanvas?.height
      ]
      let imageInfo = {
        type: "image",
        url: fullImage
      }

      // Try to get the info.json.  If we can't, continue with the simple imageInfo obj.
      if(imageService) {
          const lastchar = imageService[imageService.length-1]
          if(lastchar !== "/") imageService += "/"
          const info = await fetch(imageService+"info.json").then(resp => resp.json()).catch(err => { return false })
          if(info) imageInfo = info
      }

      /**
       * An instance of OpenSeaDragon with customization options that help our desired
       * "draw new annotation", "edit existing drawn annotation", "delete drawn annotation" UX.
       * The interface folder contains an /images/ folder with the OpenSeaDragon icons these options use.
       * @see https://openseadragon.github.io/docs/OpenSeadragon.html#.Options for all options and their description.
      */
      this.#osd = OpenSeadragon({
          element: this.shadowRoot.getElementById('annotator-container'),
          tileSources: imageInfo,
          prefixUrl: "./images/",
          // The default WebGL drawer cannot draw cross-origin images loaded without CORS, and the image goes blank.
          drawer: "canvas",
          gestureSettingsMouse:{
            clickToZoom: false,
            dblClickToZoom: true
          },
          gestureSettingsTouch:{
            clickToZoom: false,
            dblClickToZoom: true
          },
          gestureSettingsPen:{
            clickToZoom: false,
            dblClickToZoom: true
          },
          gestureSettingsUnknown:{
            clickToZoom: false,
            dblClickToZoom: true
          }
      })

      /**
       * An instance of an OpenSeaDragon Annotorious Annotation with customization options that help our desired
       * "draw new annotation", "edit existing drawn annotation", "delete drawn annotation" UX.
       * @see https://annotorious.dev/api-reference/openseadragon-annotator/ for all the available methods of this annotator.
      */
      this.#annotoriousInstance = AnnotoriousOSD.createOSDAnnotator(this.#osd, {
          adapter: AnnotoriousOSD.W3CImageFormat(canvasID),
          drawingEnabled: false,
          drawingMode: "drag",
          // https://annotorious.dev/api-reference/drawing-style/
          style: {
           fill: "#ff0000",
           fillOpacity: 0.25
          },
          userSelectAction: "EDIT"
          // EXAMPLE: Only allow me to edit my own annotations
          // userSelectAction: (annotation) => {
          //   const isMe = annotation.target.creator?.id === 'my_id';
          //   return isMe ? 'EDIT' : 'SELECT';
          // }

      })
      // "polygon" is another available option
      this.#annotoriousInstance.setDrawingTool("rectangle")
      this.setInitialAnnotations()
      this.listenTo(this)
    }

    /**
      * Listeners on all available Annotorious events involving the annotations.  See inline comments for details.
      * Here we can catch events, then do things with the Annotations from those events.
      * Lifecycle Events API is available at https://annotorious.dev/api-reference/events/
      *
      * @param annotator - An established instance of a AnnotoriousOSD.createOSDAnnotator
    */
    listenTo(_this) {
      const annotator = _this.#annotoriousInstance

      /**
        * Fired after a click event on a drawn Annotation.  The annotation data is known and available as a parameter.
        * A click on a drawn Annotation in erase mode means erase the Annotation.
        *
      */
      annotator.on('clickAnnotation', (annotation, originalEvent) => {
        if(!annotation) return
        // FIXME if the user holds the mouse down there is some goofy UX.
        if(_this.#isErasing) {
          if (_this.#eraseConfirmTimeout) clearTimeout(_this.#eraseConfirmTimeout)
          _this.#eraseConfirmTimeout = setTimeout(()=>{
            _this.#eraseConfirmTimeout = null
            // Timeout required in order to allow the click-and-focus native functionality to complete.
            // Also stops the goofy UX for naturally slow clickers.
            if(confirm("Are you sure you want to remove this?")) _this.#annotoriousInstance.removeAnnotation(annotation)
            else { _this.#annotoriousInstance.cancelSelected() }
          }, 500)
        }
      })

      /**
        * Fired after a new annotation is created and available as a shape in the DOM.
      */
      annotator.on('createAnnotation', function(annotation) {
        // console.log('Annotation Created:', annotation)
        _this.#annotoriousInstance.cancelSelected(annotation)
      })

    }

    /**
     * Resolve and process the ?iiif-content= URI, which may be a Canvas or an AnnotationPage.
     * A Canvas loads with the AnnotationPage this app saved for it, if there is one.
     * An AnnotationPage loads with the Canvas it targets.  If the page has no target, its Annotations' target is used.
     *
     * @param uri A Canvas URI or an AnnotationPage URI
    */
    async processContent(uri) {
      if(!uri) return
      const resolved = await this.fetchJSON(uri)
      const type = resolved["@type"] ?? resolved.type
      if(type === "Canvas") {
        const page = await this.findAnnotationPage(resolved["@id"] ?? resolved.id)
        this.#resolvedAnnotationPage = page ? await this.processAnnotationPage(page) : null
        return this.processCanvas(resolved)
      }
      if(type === "AnnotationPage") {
        const page = await this.processAnnotationPage(resolved)
        this.#resolvedAnnotationPage = page
        // Note this will process the id from embedded Canvas objects to pass forward and be resolved.
        const canvasURI = this.processPageTarget(page.target ?? page.items?.find(item => item.target)?.target)
        return this.processCanvas(await this.fetchJSON(canvasURI))
      }
      throw new Error(`Provided URI did not resolve a 'Canvas' or an 'AnnotationPage'.  It resolved a '${type}'`,
        {"cause":"iiif-content must point to a Canvas or an AnnotationPage."})
    }

    /**
     * Fetch a URI as JSON.  The cache is skipped because RERUM objects change in place when they are overwritten.
     *
     * @param uri A String URI
     * @return the resolved JSON
    */
    async fetchJSON(uri) {
      const response = await fetch(uri, { cache: "no-store" })
      if(!response.ok) {
        throw new Error(`Could not resolve ${uri}`,
          {"cause":`${response.status} ${response.statusText}`})
      }
      return response.json()
    }

    /**
     * Query TinyNode for the AnnotationPage this app saved for a Canvas.
     *
     * @param canvasURI A String Canvas URI
     * @return the AnnotationPage, or undefined when this app has not saved one for the Canvas
    */
    async findAnnotationPage(canvasURI) {
      const query = {
        type: "AnnotationPage",
        target: canvasURI,
        creator: CREATOR,
        "__rerum.history.next": { "$size": 0 }
      }
      const response = await fetch(`${TINY_URL}/query?limit=1`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(query)
      })
      if(!response.ok) {
        throw new Error(`Could not look up the AnnotationPage for ${canvasURI}`,
          {"cause":`${response.status} ${response.statusText}`})
      }
      const pages = await response.json()
      return pages[0]
    }

    /**
     * Validate a resolved AnnotationPage and resolve any of its items that are only referenced by id.
     *
     * @param page A resolved AnnotationPage
     * @return the AnnotationPage with its items resolved
    */
    async processAnnotationPage(page) {
      const context = page["@context"]
      if(!(context?.includes("iiif.io/api/presentation/3/context.json") || context?.includes("w3.org/ns/anno.jsonld"))) {
        console.warn("The AnnotationPage object did not have the IIIF Presentation API 3 context and may not be parseable.")
      }
      const id = page["@id"] ?? page.id
      if(!id) {
          throw new Error("Cannot Resolve AnnotationPage",
            {"cause":"The AnnotationPage is 404 or unresolvable."})
      }
      const type = page["@type"] ?? page.type
      if(type !== "AnnotationPage") {
          throw new Error(`Provided URI did not resolve an 'AnnotationPage'.  It resolved a '${type}'`,
            {"cause":"URI must point to an AnnotationPage."})
      }
      page.items = await Promise.all((page.items ?? []).map(item => {
        const itemID = item["@id"] ?? item.id
        return (item.target || !itemID) ? item : this.fetchJSON(itemID)
      }))
      return page
    }

    /**
     * Check that a resolved object is a Canvas.  Pass it forward to render the Image into the interface.
     *
     * @param resolvedCanvas A resolved Canvas object
    */
    async processCanvas(resolvedCanvas) {
      const context = resolvedCanvas["@context"]
      if(!context?.includes("iiif.io/api/presentation/3/context.json")) {
        console.warn("The Canvas object did not have the IIIF Presentation API 3 context and may not be parseable.")
      }
      const id = resolvedCanvas["@id"] ?? resolvedCanvas.id
      if(!id) {
          throw new Error("Cannot Resolve Canvas or Image",
            {"cause":"The Canvas is 404 or unresolvable."})
      }
      const type = resolvedCanvas["@type"] ?? resolvedCanvas.type
      if(type !== "Canvas") {
          throw new Error(`Provided URI did not resolve a 'Canvas'.  It resolved a '${type}'`,
            {"cause":"URI must point to a Canvas."})
      }
      return this.renderCanvas(resolvedCanvas)
    }

    /**
      * Adjust Annotation selectors as needed for communication between Annotorious and the saved AnnotationPage.
      * Annotorious naturally builds selector values relative to image dimensions.
      * Saved Annotations have them relative to Canvas dimensions.
      * When recieving Annotations to render convert the selectors so they are relative to the image and draw correctly.
      * When saving Annotations convert the selectors so they are relative to the canvas and save correctly.
      * The targets are in expanded Annotorious format either way. {source:"uri", selector:{value:"xywh="}}
      *
      * @param annotations - An Array of Annotations whose selectors need converted
      * @param bool - A switch for forwards or backwards conversion
      *
      * @return the Array of Annotations with their selectors converted
    */
    convertSelectors(annotations, bool=false) {
      // Even when the Image and Canvas dimensions match this runs, so that the saved xywh values are integers.
      if(!annotations || annotations.length === 0) return annotations
      let orig_xywh, converted_xywh = []
      let sel = ""
      return annotations.map(annotation => {
        if(!annotation.target) return annotation
        orig_xywh = annotation.target.selector.value.replace("xywh=", "").replace("pixel:", "").split(",")
        if(bool) {
          /**
           * You are converting for Annotorious.  Selectors need to be changed to be relative to the Image dimensions.
           * This is so that they render correctly.  Saved selectors are relative to the Canvas dimensions.
          */
          converted_xywh[0] = parseInt((this.#imageDims[0] / this.#canvasDims[0]) * parseInt(orig_xywh[0]))
          converted_xywh[1] = parseInt((this.#imageDims[1] / this.#canvasDims[1]) * parseInt(orig_xywh[1]))
          converted_xywh[2] = parseInt((this.#imageDims[0] / this.#canvasDims[0]) * parseInt(orig_xywh[2]))
          converted_xywh[3] = parseInt((this.#imageDims[1] / this.#canvasDims[1]) * parseInt(orig_xywh[3]))
        }
        else{
          /**
           * You are converting for saving.  Selectors need to be changed to be relative to the Canvas dimensions.
           * This is so that they save correctly.  Annotorious selectors are relative to the Image dimensions.
          */
          converted_xywh[0] = parseInt((this.#canvasDims[0] / this.#imageDims[0]) * parseInt(orig_xywh[0]))
          converted_xywh[1] = parseInt((this.#canvasDims[1] / this.#imageDims[1]) * parseInt(orig_xywh[1]))
          converted_xywh[2] = parseInt((this.#canvasDims[0] / this.#imageDims[0]) * parseInt(orig_xywh[2]))
          converted_xywh[3] = parseInt((this.#canvasDims[1] / this.#imageDims[1]) * parseInt(orig_xywh[3]))
        }
        sel = "xywh=" + converted_xywh.join(",")
        annotation.target.selector.value = sel
        return annotation
      })
    }

    /**
     * Express an Annotation target in the expanded Annotorious format. {source:"uri", selector:{value:"xywh="}}
     * The target may be a String uri#xywh= or an Object with a source and a FragmentSelector.
     *
     * @param target - The target of an Annotation
     * @return the Annotorious target, or undefined when the target has no xywh selector to draw
    */
    toAnnotoriousTarget(target) {
      let source, value
      if(typeof target === "string") [source, value] = target.split("#")
      else if(target) {
        source = target.source?.["@id"] ?? target.source?.id ?? target.source
        value = target.selector?.value
      }
      if(!source || !value?.startsWith("xywh=")) return
      return {
        source,
        selector: {
          conformsTo: "http://www.w3.org/TR/media-frags/",
          type: "FragmentSelector",
          value
        }
      }
    }

    /**
     * Format and pass along the Annotations from the AnnotationPage, if there is one.
     * Annotorious will render them on screen and introduce them to the UX flow.
    */
    setInitialAnnotations() {
      this.#undrawableItems = []
      if(!this.#resolvedAnnotationPage) return
      const drawable = []
      for(const annotation of JSON.parse(JSON.stringify(this.#resolvedAnnotationPage.items))) {
        const target = this.toAnnotoriousTarget(annotation.target)
        if(!target) {
          this.#undrawableItems.push(annotation)
          continue
        }
        annotation.target = target
        annotation.body = Array.isArray(annotation.body) ? annotation.body : annotation.body ? [annotation.body] : []
        drawable.push(annotation)
      }
      // Convert the Annotation selectors so that they are relative to the Image dimensions
      this.#annotoriousInstance.setAnnotations(this.convertSelectors(drawable, true), false)
    }

    /**
      * Save the drawn Annotations as the items of the AnnotationPage.
      * The AnnotationPage is created the first time this Canvas is saved, and overwritten after that.
    */
    async saveAnnotations() {
      if(!this.#annotoriousInstance) return
      let allAnnotations = this.#annotoriousInstance.getAnnotations()
      // Convert the Annotation selectors so that they are relative to the Canvas dimensions
      allAnnotations = this.convertSelectors(allAnnotations, false)
      allAnnotations = allAnnotations.map(annotation => {
        // A single body is saved as an Object.  Several are kept as an Array.
        annotation.body = annotation.body.length > 1 ? annotation.body : annotation.body[0] ?? {}
        const tar = annotation.target.source
        const sel = "#"+annotation.target.selector.value.replace("pixel:", "")
        annotation.target = tar + sel
        // Annotations from elsewhere keep their own motivation
        annotation.motivation ??= "transcribing"
        // Without a user set Annotorious stamps a random guest as the creator of the Annotations drawn here
        if(annotation.creator?.isGuest) annotation.creator = CREATOR
        // stop undefined from appearing on previously existing Annotations
        if(!annotation.creator) delete annotation.creator
        if(!annotation.modified) delete annotation.modified
        // We already track this in __rerum.createdAt
        delete annotation.created
        return annotation
      })
      let page = this.#resolvedAnnotationPage
        ? JSON.parse(JSON.stringify(this.#resolvedAnnotationPage))
        : {
          "@context": "http://iiif.io/api/presentation/3/context.json",
          type: "AnnotationPage",
          target: this.#canvasID,
          creator: CREATOR
        }
      page.items = [...allAnnotations, ...this.#undrawableItems]
      const saveButton = this.shadowRoot.getElementById("saveBtn")
      saveButton.disabled = true
      this.showMessage("Saving...")
      try {
        this.#resolvedAnnotationPage = await this.writeAnnotationPage(page)
        this.showMessage("Annotations saved!")
      }
      catch(err) {
        console.error(err)
        this.showMessage(err.message)
      }
      finally {
        saveButton.disabled = false
      }
    }

    /**
     * Save an AnnotationPage through TinyNode.  A page with an id is overwritten in place.  A page without one is created.
     * Overwrites send the version of the page that was loaded, so a page changed elsewhere since then fails with a 409.
     *
     * @param page - The AnnotationPage to save
     * @return the saved AnnotationPage
    */
    async writeAnnotationPage(page) {
      const { __rerum, new_obj_state, ...body } = page
      const isOverwrite = !!(body["@id"] ?? body.id)
      // Sent in the body because RERUM ignores an empty If-Overwritten-Version header, and "" is the version of a page never overwritten.
      if(isOverwrite && __rerum) body.__rerum = { isOverwritten: __rerum.isOverwritten }
      const response = await fetch(`${TINY_URL}/${isOverwrite ? "overwrite" : "create"}`, {
        method: isOverwrite ? "PUT" : "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body)
      })
      if(!response.ok) {
        throw new Error(`Saving the AnnotationPage failed (${response.status}).`,
          {"cause": await response.text().catch(() => "")})
      }
      const saved = await response.json()
      delete saved.new_obj_state
      return saved
    }

    /**
     * Process the string URI from an AnnotationPage.target value.  This value may be an Array, a JSON Object, or a String URI.
     * Process it if possible.  Attempt to determine a single Canvas URI.
     *
     * @param pageTarget an Array, a JSON Object, or a String URI value from some AnnotationPage.target
     * @return The URI from the input pageTarget
    */
    processPageTarget(pageTarget) {
      let canvasURI
      if(!pageTarget) {
        throw new Error(`Neither the AnnotationPage nor its Annotations have a target Canvas.  There is no image to load.`,
          {"cause":"AnnotationPage.target or its Annotations' target must have a value."})
      }
      if(Array.isArray(pageTarget)) {
        throw new Error(`The AnnotationPage object has multiple targets.  We cannot process this yet, and nothing will load.`,
          {"cause":"AnnotationPage.target is an Array."})
      }
      if(typeof pageTarget === "object") {
        // An embedded object, a referenced object, or a {source:"", selector:{}} object
        try{
          JSON.parse(JSON.stringify(pageTarget))
        }
        catch(err) {
          throw new Error(`The AnnotationPage target is not processable.`,
            {"cause":"AnnotationPage.target is not JSON."})
        }
        const tcid = pageTarget["@id"] ?? pageTarget.id ?? pageTarget.source?.["@id"] ?? pageTarget.source?.id ?? pageTarget.source
        if(!tcid) {
          throw new Error(`The target of the AnnotationPage does not contain an id.  There is no image to load.`,
            {"cause":"AnnotationPage.target must be a Canvas."})
        }
        // For now we don't trust the embedded Canvas and are going to take the id forward to resolve.
        canvasURI = tcid
      }
      else if(typeof pageTarget === "string") {
        // Just use it then
        canvasURI = pageTarget
      }
      // An Annotation target may carry a fragment, such as uri#xywh=
      canvasURI = canvasURI.split("#")[0]

      let uricheck
      try {
        uricheck = new URL(canvasURI)
      }
      catch (_) {}
      if(!(uricheck?.protocol === "http:" || uricheck?.protocol === "https:")) {
        throw new Error(`AnnotationPage.target string is not a URI`,
          {"cause":"AnnotationPage.target string must be a URI."})
      }
      return canvasURI
    }

    toggleDrawingMode(e) {
      if(e.target.checked) this.startDrawing()
      else { this.stopDrawing() }
    }

    toggleErasingMode(e) {
      if(e.target.checked) this.startErasing()
      else { this.stopErasing() }
    }

    toggleAnnotationVisibility(e) {
      if(e.target.checked) this.showAnnotations()
      else { this.hideAnnotations() }
    }

    /**
     * Use Annotorious to show all known Annotations
     * https://annotorious.dev/api-reference/openseadragon-annotator/#setvisible
    */
    showAnnotations() {
      this.#annotoriousInstance.setVisible(true)
      this.showMessage("Annotations are visible")
    }

    /**
     * Use Annotorious to hide all visible Annotations (except the one in focus, if any)
     * https://annotorious.dev/api-reference/openseadragon-annotator/#setvisible
    */
    hideAnnotations() {
      this.#annotoriousInstance.setVisible(false)
      this.showMessage("Annotations are hidden")
    }

    /**
     * Activate Annotorious annotation drawing mode.
     * This makes it so the user cannot zoom and pan.
    */
    startDrawing() {
      this.stopErasing()
      this.#isDrawing = true
      this.shadowRoot.getElementById("eraseTool").checked = false
      this.#annotoriousInstance.setDrawingEnabled(true)
      this.showMessage("You started drawing")
    }

    /**
     * Deactivate Annotorious annotation drawing mode.
     * This makes it so that the user can zoom and pan.
    */
    stopDrawing() {
      this.#isDrawing = false
      this.#annotoriousInstance.setDrawingEnabled(false)
      this.showMessage("You stopped drawing")
    }

    /**
     * Activate Annotorious annotation erasing mode.
     * Clicking on an existing annotation will prompt the user about deleting the annotation.
    */
    startErasing() {
      this.stopDrawing()
      this.#isErasing = true
      this.shadowRoot.getElementById("drawTool").checked = false
      this.showMessage("You started erasing")
    }

    /**
     * Deactivate Annotorious annotation erasing mode.
     * This allows user to zoom and pan, and select annotations to edit.
    */
    stopErasing() {
      this.#isErasing = false
      this.showMessage("You stopped erasing")
    }
}

customElements.define('simple-canvas-annotator', AnnotoriousAnnotator)
