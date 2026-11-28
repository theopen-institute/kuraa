// The R side of rendering a document (render.ts). Started with Rscript in the
// environment, once per render:
//
//   Rscript render.R <document> <html|docx|pdf|epub> <scratch> [<folders>]
//
// <folders>: where what the document refers to is found besides its own folder,
// separated by colons (a compiled folder's documents', 0093).
//
// An R Markdown document is knitted by rmarkdown::render; a Markdown document
// goes to pandoc directly. Either way the workspace is only read: intermediate
// files and the output go to <scratch>/tmp and <scratch>/out/document.<ext>.
// The last line on standard output is the result, prefixed, as JSON:
// { ok, message, notes } (notes: what people should know about how it was made).
//
// What the header asks for is followed where it can be: R Markdown's `output:`
// (html_document, word_document, pdf_document and others, with their options)
// and the `format:` of Quarto-style headers (toc, number-sections, pdf-engine),
// those also at the header's top level as Quarto has them for every format
// (toc, number-sections, reference-doc, and cover-image for EPUB: 0106).
// HTML is always self-contained (images and styles inside), with math as MathML
// unless the header chooses, so it shows without scripts or the network. PDF is
// made with Typst unless the header asks for a LaTeX engine the environment has
// (the image's, or a tool's: render.ts mounts TinyTeX and names its programs'
// folder in KURAA_TOOL_PATH).
//
// Kept as a string so it ships inside every bundle. The R code uses no backticks
// or dollar-brace sequences, to stay a plain template.

export const RENDER_PREFIX = '\u001fkuraa-render\u001f';

export const RENDER_SCRIPT = String.raw`
local({
  PREFIX <- "\037kuraa-render\037"
  args <- commandArgs(trailingOnly = TRUE)
  input <- args[[1]]
  format <- args[[2]]
  scratch <- args[[3]]
  resources <- if (length(args) >= 4 && nzchar(args[[4]])) strsplit(args[[4]], ":", fixed = TRUE)[[1]] else character()
  out_dir <- file.path(scratch, "out")
  tmp_dir <- file.path(scratch, "tmp")
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  dir.create(tmp_dir, showWarnings = FALSE, recursive = TRUE)
  ext <- c(html = "html", docx = "docx", pdf = "pdf", epub = "epub")[[format]]
  out_name <- paste0("document.", ext)
  out_file <- file.path(out_dir, out_name)
  notes <- character()
  or <- function(a, b) if (is.null(a) || length(a) == 0) b else a

  reply <- function(ok, message = "") {
    json <- if (requireNamespace("jsonlite", quietly = TRUE)) {
      jsonlite::toJSON(list(ok = ok, message = message, notes = I(notes)), auto_unbox = TRUE)
    } else sprintf('{"ok":%s,"message":"%s"}', tolower(ok), gsub("[^A-Za-z0-9 .,:;()'-]", " ", message))
    cat("\n", PREFIX, json, "\n", sep = "")
  }

  # The workspace's own packages, as for runs.
  ws_lib <- Sys.getenv("KURAA_R_LIB")
  if (nzchar(ws_lib) && dir.exists(ws_lib)) .libPaths(c(ws_lib, .libPaths()))

  # A tool's programs (TinyTeX's), first on PATH for this process and what it starts.
  tool_path <- Sys.getenv("KURAA_TOOL_PATH")
  if (nzchar(tool_path)) Sys.setenv(PATH = paste(tool_path, Sys.getenv("PATH"), sep = .Platform$path.sep))
  # The tool is mounted read-only and there is no network: tinytex must never
  # try to install LaTeX packages itself (it would only fail, slowly). It
  # already decides so (its folder is not writable); this makes sure. The host
  # adds what the log says was missing, and renders again.
  if (requireNamespace("tinytex", quietly = TRUE)) {
    try(utils::assignInNamespace("tlmgr_writable", function() FALSE, "tinytex"), silent = TRUE)
  }
  # Its log is kept when LaTeX fails (in scratch, emptied after every render): see latex_errors().
  options(tinytex.clean = FALSE)

  have <- function(program) nzchar(Sys.which(program))
  # A program that is there but cannot start (a TeX built for another C library, say).
  runs <- function(program) isTRUE(tryCatch(suppressWarnings(system2(program, "--version", stdout = FALSE, stderr = FALSE)) == 0, error = function(e) FALSE))
  LATEX <- c("pdflatex", "xelatex", "lualatex", "tectonic", "latexmk")

  main <- function() {
    # The host has just written the document (atomically, as a new file): a folder shared
    # into a virtual machine (Podman on a Mac) can take a moment to show it.
    for (i in 1:50) {
      if (file.exists(input)) break
      Sys.sleep(0.1)
    }
    if (!requireNamespace("rmarkdown", quietly = TRUE)) stop("Rendering needs the rmarkdown package, which this environment does not have.")
    header <- tryCatch(rmarkdown::yaml_front_matter(input), error = function(e) list())
    if (!is.list(header)) header <- list()
    # R Markdown's output: a name, a list of names, or names with options.
    output <- header[["output"]]
    entries <- if (is.null(output)) list()
      else if (is.character(output)) stats::setNames(rep(list(list()), length(output)), output)
      else if (is.list(output)) output
      else list()
    pick <- function(pattern) {
      hit <- names(entries)[grepl(pattern, names(entries))]
      if (length(hit)) hit[[1]] else NULL
    }
    options_of <- function(name) if (!is.null(name) && is.list(entries[[name]])) entries[[name]] else list()
    # Quarto-style: format: { html: { toc: true }, pdf: { pdf-engine: xelatex } }.
    quarto <- function(key) {
      f <- header[["format"]]
      if (is.list(f) && is.list(f[[key]])) f[[key]] else list()
    }
    chosen <- switch(format, html = pick("html"), docx = pick("word|docx"), pdf = pick("pdf"), epub = pick("epub"))
    opts <- options_of(chosen)
    q <- quarto(format)
    # Quarto-style options at the header's top level, for every format.
    top <- function(key) or(q[[key]], header[[key]])
    toc <- isTRUE(or(opts$toc, top("toc")))
    numbered <- isTRUE(or(opts$number_sections, top("number-sections")))

    # PDF: Typst, unless the header asks for a LaTeX engine the environment has.
    pdf_engine <- NULL
    if (format == "pdf") {
      wanted <- or(opts$latex_engine, or(q[["pdf-engine"]], header[["pdf-engine"]]))
      broken <- !is.null(wanted) && wanted %in% LATEX && have(wanted) && !runs(wanted)
      if (!is.null(wanted) && wanted %in% LATEX && have(wanted) && !broken) pdf_engine <- wanted
      else if (have("typst")) {
        pdf_engine <- "typst"
        if (broken) {
          notes <<- c(notes, sprintf("The header asks for %s, which cannot run in this environment's image, so the PDF was made with Typst: settings only LaTeX understands were left out.", wanted))
        } else if (!is.null(wanted) && wanted %in% LATEX) {
          notes <<- c(notes, sprintf("The header asks for %s, which this environment does not have, so the PDF was made with Typst: settings only LaTeX understands were left out.", wanted))
        }
      } else {
        latex <- LATEX[vapply(LATEX, have, logical(1))]
        if (length(latex)) pdf_engine <- latex[[1]]
        else stop("Making a PDF needs Typst or LaTeX, and this environment has neither. Render to HTML or Word instead.")
      }
    }

    if (grepl("\\.rmd$", input, ignore.case = TRUE)) render_rmd(chosen, opts, toc, numbered, pdf_engine)
    else render_md(header, opts, toc, numbered, pdf_engine, top)
    if (!file.exists(out_file)) stop("The render finished but made no file.")
  }

  # R Markdown: knitted by rmarkdown::render, in the document's folder, everything it writes in scratch.
  render_rmd <- function(chosen, opts, toc, numbered, pdf_engine) {
    format_function <- function(name) {
      fn <- tryCatch(eval(parse(text = if (grepl("::", name, fixed = TRUE)) name else paste0("rmarkdown::", name))), error = function(e) NULL)
      if (is.function(fn)) names(formals(fn)) else character()
    }
    output_format <- NULL
    output_options <- list()
    if (format == "html") {
      output_format <- or(chosen, "html_document")
      takes <- format_function(output_format)
      if ("self_contained" %in% takes) output_options$self_contained <- TRUE
      if ("math_method" %in% takes && is.null(opts$math_method) && is.null(opts$mathjax)) output_options$math_method <- "mathml"
    } else if (format == "docx") {
      output_format <- or(chosen, "word_document")
    } else if (format == "epub") {
      # An output format the header names (bookdown::epub_book), else pandoc's EPUB 3.
      output_format <- if (!is.null(chosen)) chosen else rmarkdown::output_format(
        knitr = rmarkdown::knitr_options(opts_chunk = list(dev = "png", dpi = 192)),
        pandoc = rmarkdown::pandoc_options(to = "epub3", ext = ".epub", args = c("--mathml", if (toc) "--toc", if (numbered) "--number-sections")),
        keep_md = FALSE, clean_supporting = TRUE)
    } else if (pdf_engine != "typst") {
      output_format <- or(chosen, "pdf_document")
      output_options$latex_engine <- pdf_engine
      # LaTeX writes beside where it runs, and rmarkdown runs it from the
      # document's folder, which is read-only: run it beside the .tex, in scratch.
      try(utils::assignInNamespace("latexmk", function(file, engine, biblatex = FALSE) {
        owd <- setwd(dirname(file))
        on.exit(setwd(owd), add = TRUE)
        tinytex::latexmk(basename(file), engine, if (biblatex) "biber" else "bibtex")
      }, "rmarkdown"), silent = TRUE)
    } else {
      output_format <- rmarkdown::output_format(
        knitr = rmarkdown::knitr_options(opts_chunk = list(dev = "png", dpi = 192, fig.width = or(opts$fig_width, 6.5), fig.height = or(opts$fig_height, 4.5))),
        pandoc = rmarkdown::pandoc_options(to = "typst", ext = ".pdf", args = c("--pdf-engine=typst", if (toc) "--toc", if (numbered) "--number-sections")),
        keep_md = FALSE, clean_supporting = TRUE)
    }
    rmarkdown::render(input, output_format = output_format, output_options = if (length(output_options)) output_options else NULL,
      output_file = out_name, output_dir = out_dir, intermediates_dir = tmp_dir, knit_root_dir = dirname(input),
      envir = new.env(parent = globalenv()), quiet = FALSE)
  }

  # Markdown: pandoc, run from scratch (it writes beside where it runs), finding
  # images and the bibliography in the document's folder. With pandoc's own
  # sandbox where the document needs no files of the workspace besides its
  # bibliography (it then reads nothing else); the container keeps it to the
  # workspace, read-only, either way.
  render_md <- function(header, opts, toc, numbered, pdf_engine, top) {
    dir <- dirname(input)
    body <- paste(readLines(input, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
    reads_files <- grepl("!\\[|<img|<embed|<object|<video|<audio|<source|<link|src\\s*=", body, ignore.case = TRUE) ||
      any(names(header) %in% c("csl", "include-in-header", "include-before-body", "include-after-body", "css", "reference-doc", "template", "logo", "header-includes", "cover-image"))
    args <- c(input, "--standalone", "--citeproc", paste0("--resource-path=", paste(c(dir, resources), collapse = ":")), "-o", out_file)
    if (format == "html") {
      args <- c(args, "--embed-resources", "--mathml")
      if (is.null(header[["title"]]) && is.null(header[["pagetitle"]])) args <- c(args, "--metadata", paste0("pagetitle=", sub("\\.[^.]*$", "", basename(input))))
    }
    # A Word template: R Markdown's reference_docx, or reference-doc; beside the document.
    reference <- or(opts$reference_docx, top("reference-doc"))
    if (format == "docx" && is.character(reference)) {
      args <- c(args, paste0("--reference-doc=", file.path(dir, reference)))
      reads_files <- TRUE
    }
    if (format == "epub") {
      args <- c(args, "--mathml")
      if (is.null(header[["title"]]) && is.null(header[["pagetitle"]])) args <- c(args, "--metadata", paste0("title=", sub("\\.[^.]*$", "", basename(input))))
      # A cover beside the document (pandoc would look for it where it runs, in scratch).
      cover <- top("cover-image")
      if (is.character(cover)) {
        args <- c(args, paste0("--epub-cover-image=", file.path(dir, cover)))
        reads_files <- TRUE
      }
    }
    if (format == "pdf") args <- c(args, if (pdf_engine == "typst") c("-t", "typst"), paste0("--pdf-engine=", pdf_engine))
    if (toc) args <- c(args, "--toc")
    if (numbered) args <- c(args, "--number-sections")
    if (!reads_files) args <- c(args, "--sandbox")
    cat("pandoc", args, "\n")
    said <- suppressWarnings(system2("pandoc", shQuote(args), stdout = TRUE, stderr = TRUE))
    if (length(said)) cat(said, sep = "\n")
    status <- attr(said, "status")
    if (!is.null(status) && status != 0) {
      last <- tail(said[nzchar(trimws(said))], 1)
      stop(if (length(last)) paste("pandoc:", last) else sprintf("pandoc stopped with status %s.", status))
    }
  }

  # LaTeX's own errors, from its logs, for people (behind Details) and for the
  # host, which reads them for packages that were missing.
  latex_errors <- function() {
    logs <- list.files(c(out_dir, tmp_dir), pattern = "[.]log$", full.names = TRUE)
    for (f in logs) {
      lines <- tryCatch(readLines(f, warn = FALSE), error = function(e) character())
      at <- grep("^!", lines)
      if (length(at)) cat("\nLaTeX (", basename(f), "):\n", paste(unique(unlist(lapply(head(at, 20), function(i) lines[i:min(length(lines), i + 2)]))), collapse = "\n"), "\n", sep = "")
    }
  }

  ok <- tryCatch({
    main()
    TRUE
  }, error = function(e) {
    latex_errors()
    reply(FALSE, conditionMessage(e))
    FALSE
  })
  if (ok) reply(TRUE)
  quit(save = "no", status = if (ok) 0 else 1)
})
`;
