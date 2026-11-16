# Clean the wellbeing survey and write an analysis-ready file.
library(dplyr)
library(readr)

raw <- read_csv("data/raw/survey-2024.csv", show_col_types = FALSE)

#' Recode Likert items to 1-5, treating "Prefer not to say" as missing.
recode_likert <- function(x) {
  levels <- c("Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree")
  out <- match(x, levels)
  out[x == "Prefer not to say"] <- NA_integer_
  out
}

clean <- raw |>
  filter(!is.na(respondent_id), consent == TRUE) |>
  mutate(across(starts_with("wb_"), recode_likert),
         wb_total = rowSums(across(starts_with("wb_")), na.rm = FALSE),
         age_band = cut(age, breaks = c(17, 24, 34, 49, 64, Inf)))

stopifnot(nrow(clean) > 0, all(clean$wb_total <= 25, na.rm = TRUE))
write_rds(clean, "data/clean/survey-2024.rds")
message(sprintf("Wrote %d rows (%.1f%% complete)", nrow(clean), 100 * mean(complete.cases(clean))))
