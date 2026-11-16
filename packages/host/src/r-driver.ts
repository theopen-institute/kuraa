// The R side of the chunk runner. The host writes this to .git/kuraa/run/ and
// starts it with Rscript, once per document. It reads one JSON request per line
// on stdin, evaluates the code with evaluate (as knitr does) in the global
// environment, and writes one JSON reply per line on stdout, prefixed so that
// stray output from user code cannot be mistaken for a reply.
//
// Kept as a string so it ships inside every bundle (the desktop app included).
// The R code uses no backticks or dollar-brace sequences, to stay a plain template.

export const REPLY_PREFIX = '\u001fkuraa\u001f';

export const R_DRIVER = String.raw`
local({
  PREFIX <- "\037kuraa\037"
  need <- c("evaluate", "jsonlite")
  missing <- need[!vapply(need, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) {
    cat(PREFIX, '{"type":"fatal","message":"Running R chunks needs the ', paste(missing, collapse = " and "),
        ' package(s). Install with install.packages(c(', paste0('\\"', missing, '\\"', collapse = ", "), '))."}', "\n", sep = "")
    quit(save = "no", status = 3)
  }

  send <- function(x) {
    json <- jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null", digits = NA, force = TRUE)
    cat(PREFIX, json, "\n", sep = "")
    flush(stdout())
  }

  or <- function(a, b) if (is.null(a) || length(a) == 0) b else a

  # Chunk options as knitr reads them: {r label, fig.width = 6, eval = FALSE}.
  chunk_options <- function(text) {
    if (!nzchar(trimws(text)) || !requireNamespace("knitr", quietly = TRUE)) return(list())
    parse <- get("parse_params", envir = asNamespace("knitr"))
    opts <- parse(text)
    lapply(opts, function(v) if (is.language(v)) eval(v, globalenv()) else v)
  }

  device <- if (requireNamespace("ragg", quietly = TRUE)) {
    function(file, w, h, res) ragg::agg_png(file, width = w, height = h, units = "in", res = res)
  } else {
    function(file, w, h, res) grDevices::png(file, width = w, height = h, units = "in", res = res)
  }

  show_value <- function(x, visible) {
    if (!visible) return(invisible(NULL))
    if (is.data.frame(x)) return(structure(list(df = x), class = "kuraa_table"))
    print(x)
    invisible(NULL)
  }

  cells <- function(col) {
    out <- tryCatch({
      if (is.list(col)) vapply(col, function(e) paste(format(e), collapse = " "), character(1))
      else format(col, trim = TRUE, justify = "none")
    }, error = function(e) as.character(col))
    if (!is.list(col)) out[is.na(col)] <- "NA"
    unname(out)
  }

  table_output <- function(df) {
    k <- min(nrow(df), 1000L)
    part <- df[seq_len(k), , drop = FALSE]
    data <- lapply(seq_along(part), function(i) I(cells(part[[i]])))
    rn <- attr(df, "row.names")
    list(type = "table", columns = I(names(df)),
         types = I(vapply(df, function(c) class(c)[1], character(1), USE.NAMES = FALSE)),
         data = data, rownames = if (is.character(rn)) I(rownames(part)) else NULL,
         nrow = nrow(df), ncol = ncol(df))
  }

  error_text <- function(e) {
    call <- conditionCall(e)
    where <- if (is.null(call)) "" else paste0(" in ", paste(deparse(call, width.cutoff = 80L)[1], collapse = ""))
    paste0("Error", where, ": ", conditionMessage(e))
  }

  run <- function(req) {
    if (!is.null(req$dir) && dir.exists(req$dir)) setwd(req$dir)
    opts <- tryCatch(chunk_options(or(req$options, "")), error = function(e) list())
    if (isFALSE(opts$eval)) return(list(outputs = list(list(type = "note", text = "Not run: the chunk has eval = FALSE."))))
    dim <- or(opts$fig.dim, c(NA, NA))
    w <- as.numeric(or(opts$fig.width, if (is.na(dim[1])) 7 else dim[1]))
    h <- as.numeric(or(opts$fig.height, if (is.na(dim[2])) 5 else dim[2]))
    res <- evaluate::evaluate(req$code, envir = globalenv(), stop_on_error = 1L,
                              output_handler = evaluate::new_output_handler(value = show_value))
    res <- tryCatch(get("merge_low_plot", envir = asNamespace("knitr"))(res), error = function(e) res)
    outputs <- list()
    add <- function(x) outputs[[length(outputs) + 1L]] <<- x
    plots <- 0L
    for (r in res) {
      if (evaluate::is.source(r)) next
      if (is.character(r)) add(list(type = "text", text = paste(r, collapse = "")))
      else if (inherits(r, "recordedplot")) {
        plots <- plots + 1L
        file <- file.path(req$out, sprintf("%s-%d.png", req$id, plots))
        device(file, w, h, 192)
        tryCatch(grDevices::replayPlot(r), finally = grDevices::dev.off())
        add(list(type = "image", file = file, width = round(w * 96), height = round(h * 96)))
      }
      else if (inherits(r, "error")) add(list(type = "error", text = error_text(r)))
      else if (inherits(r, "warning")) add(list(type = "warning", text = paste0("Warning: ", conditionMessage(r))))
      else if (inherits(r, "message")) add(list(type = "message", text = conditionMessage(r)))
      else if (inherits(r, "kuraa_table")) add(table_output(r$df))
    }
    list(outputs = outputs)
  }

  con <- file("stdin", open = "r")
  send(list(type = "ready", r = R.version.string))
  repeat {
    line <- tryCatch(readLines(con, n = 1L, warn = FALSE), interrupt = function(e) NA_character_)
    if (!length(line)) break
    if (is.na(line) || !nzchar(line)) next
    req <- tryCatch(jsonlite::fromJSON(line, simplifyVector = FALSE), error = function(e) NULL)
    if (is.null(req)) next
    reply <- tryCatch(run(req),
      interrupt = function(e) list(interrupted = TRUE, outputs = list()),
      error = function(e) list(outputs = list(list(type = "error", text = paste("The runner failed:", conditionMessage(e))))))
    reply$type <- "result"
    reply$id <- req$id
    send(reply)
  }
})
`;
