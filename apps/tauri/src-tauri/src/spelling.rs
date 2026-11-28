// The system's spell checker, always (the owner's direction, decision 0127):
// the webview underlines and corrects misspelled words itself, with the
// system's dictionary, in its own right-click menu; this is for the editor's own
// menus (a table's), which take that menu's place: a word's suggestions, and
// Add to Dictionary. On a Mac, NSSpellChecker, on the main thread as AppKit
// asks; elsewhere none yet (the editor's menus then offer no suggestions, and
// the webview's own spell checking goes on: WebView2's, WebKitGTK's).

/// Spelling checked as you type, unless the person turned it off (the webview's
/// right-click menu, Spelling and Grammar): WKWebView reads the system's
/// setting for this app, which is off until something says otherwise.
#[cfg(target_os = "macos")]
pub fn check_as_you_type() {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};
    let key = NSString::from_str("WebContinuousSpellCheckingEnabled");
    let yes = NSNumber::new_bool(true);
    let value: &AnyObject = yes.as_ref();
    let defaults = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[value]);
    #[allow(unused_unsafe)]
    unsafe {
        NSUserDefaults::standardUserDefaults().registerDefaults(&defaults)
    };
}

#[cfg(not(target_os = "macos"))]
pub fn check_as_you_type() {}

/// A misspelled word's suggestions (perhaps none), or None if it is spelled right. On the main thread.
#[cfg(target_os = "macos")]
pub fn suggest(word: &str) -> Option<Vec<String>> {
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSNotFound, NSString};
    let checker = NSSpellChecker::sharedSpellChecker();
    let text = NSString::from_str(word);
    let range = checker.checkSpellingOfString_startingAt(&text, 0);
    if range.location == NSNotFound as usize {
        return None;
    }
    let guesses = checker.guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &text, None, 0);
    Some(guesses.map(|g| g.iter().take(6).map(|s| s.to_string()).collect()).unwrap_or_default())
}

#[cfg(not(target_os = "macos"))]
pub fn suggest(_word: &str) -> Option<Vec<String>> {
    None
}

/// Take a word as spelled right from now on, in the system's dictionary. On the main thread.
#[cfg(target_os = "macos")]
pub fn learn(word: &str) {
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::NSString;
    NSSpellChecker::sharedSpellChecker().learnWord(&NSString::from_str(word));
}

#[cfg(not(target_os = "macos"))]
pub fn learn(_word: &str) {}
