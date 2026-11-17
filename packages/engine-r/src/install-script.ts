// The R package installer. Runs in its own process, in the same environment as
// sessions but with the network and without the workspace: it can fetch
// packages, and cannot see the data the code under analysis works on.
//
// Packages go into a staging library first, then each package version is moved
// into the shared cache (once per host: keyed by name, version and a hash of its
// DESCRIPTION) and the workspace's library gets a relative link to it. So a
// version another workspace already has costs nothing, and workspaces can use
// different versions. Kept: versions the workspace already links, and packages
// the environment itself provides, unless a newly installed package needs a
// newer one. Its request comes in KURAA_INSTALL (JSON); progress goes to stdout,
// the result as one prefixed JSON line.
//
// Kept as a string so it ships inside every bundle; no backticks or dollar-braces.

export const R_INSTALLER = String.raw`
local({
  PREFIX <- "\037kuraa\037"
  send <- function(x) {
    cat(PREFIX, jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", digits = NA), "\n", sep = "")
    flush(stdout())
  }
  fail <- function(message, ...) {
    send(c(list(type = "result", ok = FALSE, message = message), list(...)))
    quit(save = "no", status = 0)
  }
  req <- jsonlite::fromJSON(Sys.getenv("KURAA_INSTALL"), simplifyVector = FALSE)
  lib <- req$lib
  cache <- req$cache
  dir.create(lib, recursive = TRUE, showWarnings = FALSE)
  dir.create(cache, recursive = TRUE, showWarnings = FALSE)
  repos <- getOption("repos")
  if (is.null(repos) || identical(unname(repos[["CRAN"]]), "@CRAN@")) options(repos = c(CRAN = "https://cloud.r-project.org"))

  image_libs <- setdiff(normalizePath(.libPaths(), mustWork = FALSE), normalizePath(lib, mustWork = FALSE))
  desc_of <- function(dir) as.list(read.dcf(file.path(dir, "DESCRIPTION"))[1, ])
  version_in <- function(libs, name) {
    for (l in libs) {
      d <- file.path(l, name, "DESCRIPTION")
      if (file.exists(d)) return(package_version(read.dcf(d, fields = "Version")[1, 1]))
    }
    NULL
  }
  is_link <- function(path) nzchar(Sys.readlink(path))

  # The workspace's library as it is, with a ref that installs each exact version again.
  listing <- function() {
    pkgs <- lapply(list.dirs(lib, recursive = FALSE, full.names = FALSE), function(n) {
      d <- tryCatch(desc_of(file.path(lib, n)), error = function(e) NULL)
      if (is.null(d)) return(NULL)
      ref <- if (identical(d$RemoteType, "github")) paste0(d$RemoteUsername, "/", d$RemoteRepo, "@", d$RemoteSha)
        else if (identical(d$RemoteType, "bioc")) paste0("bioc::", n)
        else paste0(n, "@", d$Version)
      list(name = n, version = d$Version, ref = ref)
    })
    Filter(Negate(is.null), pkgs)
  }

  # What each ref names: pkg, pkg@1.2.3, bioc::pkg, owner/repo[@ref], github::owner/repo.
  refs <- unlist(req$refs)
  plain <- sub("@.*$", "", sub("^(bioc|cran)::", "", refs))
  github <- grepl("/", plain)
  wanted_names <- plain[!github]
  wanted_repos <- sub("^github::", "", plain[github])

  # Environment-provided packages a workspace used, missing here: install those too.
  for (u in req$environment) {
    have <- version_in(c(image_libs, lib), u$name)
    if (is.null(have) || have < package_version(u$version)) {
      refs <- c(refs, paste0(u$name, "@", u$version))
      wanted_names <- c(wanted_names, u$name)
    }
  }
  # Plain names that are already available (in the workspace or the environment)
  # need nothing: say so, rather than reinstalling them and all they depend on.
  plain_cran <- grepl("^(cran::)?[A-Za-z][A-Za-z0-9.]*$", refs)
  present <- vapply(seq_along(refs), function(i) plain_cran[i] && !is.null(version_in(c(lib, image_libs), sub("^cran::", "", refs[i]))), logical(1))
  already <- refs[present]
  refs <- refs[!present]
  wanted_names <- setdiff(wanted_names, sub("^cran::", "", already))
  # Those the environment provides (not the workspace's library): to record as used.
  from_env <- lapply(sub("^cran::", "", already), function(n) {
    if (!is.null(version_in(lib, n))) return(NULL)
    list(name = n, version = format(version_in(image_libs, n)))
  })
  from_env <- Filter(Negate(is.null), from_env)
  if (!length(refs)) {
    found <- vapply(already, function(n) paste(sub("^cran::", "", n), format(version_in(c(lib, image_libs), sub("^cran::", "", n)))), character(1))
    send(list(type = "result", ok = TRUE, message = if (length(found)) paste0("Already available: ", paste(found, collapse = ", "), ".") else "Nothing to install.",
              installed = I(character()), packages = listing(), environment = from_env))
    quit(save = "no", status = 0)
  }

  has_pak <- requireNamespace("pak", quietly = TRUE)
  if (!has_pak && any(github | grepl("::|@", refs))) fail("Installing from GitHub, Bioconductor or by version needs the pak package in the environment.")

  # System libraries the packages need, on Debian or Ubuntu: if any are missing,
  # say which, so the environment can be rebuilt with them.
  if (has_pak && nzchar(Sys.which("dpkg-query"))) {
    sr <- tryCatch(pak::pkg_sysreqs(refs, upgrade = FALSE), error = function(e) NULL)
    if (!is.null(sr) && length(sr$packages$system_packages)) {
      need <- unique(unlist(sr$packages$system_packages))
      # Quoted: system2() runs a shell, which would expand the format string.
      have <- system2("dpkg-query", c("-W", shQuote(paste0("-f=", "$", "{Package}\\n"))), stdout = TRUE, stderr = FALSE)
      missing <- setdiff(need, have)
      if (length(missing)) fail("Some system libraries are needed first.", system = I(missing))
    }
  }

  staging <- tempfile("staging")
  dir.create(staging)
  ok <- tryCatch({
    if (has_pak) pak::pkg_install(refs, lib = staging, upgrade = FALSE, ask = FALSE)
    else utils::install.packages(refs, lib = staging, quiet = FALSE)
    TRUE
  }, error = function(e) conditionMessage(e))
  if (!isTRUE(ok)) fail(paste("The install failed:", ok))

  staged <- list.dirs(staging, recursive = FALSE, full.names = FALSE)
  staged <- staged[file.exists(file.path(staging, staged, "DESCRIPTION"))]
  if (!length(staged)) fail("Nothing was installed.")
  descs <- lapply(staged, function(n) desc_of(file.path(staging, n)))
  names(descs) <- staged
  requested <- function(n) {
    d <- descs[[n]]
    n %in% wanted_names || (!is.null(d$RemoteRepo) && paste0(d$RemoteUsername, "/", d$RemoteRepo) %in% sub("@.*$", "", wanted_repos))
  }

  # Which staged packages to link: requested ones, ones not available otherwise,
  # and ones a linked package needs a newer version of. Repeat until stable.
  link <- Filter(function(n) requested(n) || is.null(version_in(c(lib, image_libs), n)), staged)
  repeat {
    needs <- unlist(lapply(link, function(n) {
      d <- descs[[n]]
      fields <- unlist(d[intersect(c("Depends", "Imports", "LinkingTo"), names(d))])
      m <- regmatches(fields, gregexpr("[A-Za-z][A-Za-z0-9.]*\\s*\\(>=?\\s*[0-9][0-9.-]*\\)", fields))
      unlist(m)
    }))
    more <- character()
    for (x in needs) {
      name <- sub("\\s*\\(.*$", "", x)
      min <- package_version(sub("^.*>=?\\s*([0-9][0-9.-]*)\\).*$", "\\1", x))
      if (!(name %in% staged) || name %in% link) next
      have <- version_in(c(lib, image_libs), name)
      if (is.null(have) || have < min) more <- c(more, name)
    }
    if (!length(more)) break
    link <- union(link, more)
  }

  for (n in link) {
    d <- descs[[n]]
    # The same build of the same version is the same entry, however it was asked
    # for (pak records the request in DESCRIPTION, so the file itself differs).
    stamp <- tempfile()
    writeLines(paste(n, d$Version, if (is.null(d$Built)) "" else d$Built, if (is.null(d$RemoteSha)) "" else d$RemoteSha), stamp)
    key <- paste0(n, "_", d$Version, "_", substr(unname(tools::md5sum(stamp)), 1, 12))
    unlink(stamp)
    dest <- file.path(cache, key, n)
    if (!dir.exists(dest)) {
      dir.create(dirname(dest), recursive = TRUE, showWarnings = FALSE)
      if (!file.rename(file.path(staging, n), dest)) {
        tmp <- paste0(dest, ".", Sys.getpid())
        dir.create(tmp)
        file.copy(list.files(file.path(staging, n), full.names = TRUE, all.files = TRUE, no.. = TRUE), tmp, recursive = TRUE)
        if (!file.rename(tmp, dest)) unlink(tmp, recursive = TRUE)
      }
    }
    at <- file.path(lib, n)
    if (is_link(at)) file.remove(at) else if (dir.exists(at)) unlink(at, recursive = TRUE)
    file.symlink(file.path("..", "..", "cache", key, n), at)
  }
  unlink(staging, recursive = TRUE)

  send(list(type = "result", ok = TRUE, installed = I(link), packages = listing(), environment = from_env))
})
`;
