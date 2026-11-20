import Foundation
@testable import MangaLibrary

// Home search's state machine (HomeSearch) and order (SearchOrder).
enum SearchChecks {
    static func run() {
        machine()
        order()
    }

    static func machine() {
        let hua = [SearchMatch(id: "mount-hua", confidence: 95)], troll = [SearchMatch(id: "troll", confidence: 90)]
        var search = HomeSearch()
        expect(!search.offered && search.submit("mount hua") == [], "Hidden: Enter does nothing")
        expect(search.availability(true) == [] && search.phase == .ready && search.offered, "Offered once the PC and its model answer")
        expect(search.submit("   ") == [] && search.phase == .ready, "Enter with nothing typed keeps the usual order")
        expect(search.submit("  mount hua ") == [.startSearch(query: "mount hua", request: 1)] && search.busy, "Enter asks the PC for the trimmed text")
        let first = SearchResult(query: "mount hua", matches: hua)
        expect(search.finished(request: 1, matches: hua) == [.rememberPosition, .order(first), .scrollToTop],
               "The first result keeps Home's position, applies its order and shows its best match at the top")
        expect(search.shown == first && !search.busy, "The result is shown")

        expect(search.submit("troll") == [.startSearch(query: "troll", request: 2)] && search.shown == first, "A new search keeps the shown result meanwhile")
        expect(search.finished(request: 1, matches: troll) == [], "An answer to an older request changes nothing")
        expect(search.failed(request: 2) == [.checkAvailability] && search.phase == .showing(first), "A failed search keeps what was shown and rechecks availability")

        expect(search.submit("x") == [.startSearch(query: "x", request: 3)], "A third search starts")
        expect(search.submit("troll") == [.cancelSearch, .startSearch(query: "troll", request: 4)], "Enter again cancels the running search")
        expect(search.failed(request: 3) == [] && search.finished(request: 3, matches: hua) == [], "The cancelled request cannot finish or fail the new one")
        let second = SearchResult(query: "troll", matches: troll)
        expect(search.finished(request: 4, matches: troll) == [.order(second), .scrollToTop], "A later result keeps the first remembered position")

        expect(search.emptied() == [.order(nil), .returnToPosition] && search.phase == .ready, "Emptying the box restores the usual order and position")
        expect(search.emptied() == [], "Emptying it again does nothing")
        expect(search.submit("a") == [.startSearch(query: "a", request: 5)] && search.emptied() == [.cancelSearch] && search.phase == .ready,
               "Emptying the box while the first search runs cancels it; the usual order never left")
        expect(search.finished(request: 5, matches: hua) == [], "and its late answer is ignored")

        _ = search.submit("hua"); _ = search.finished(request: 6, matches: hua)
        expect(search.submit("") == [.order(nil), .returnToPosition], "Enter on an empty box restores the usual order too")

        _ = search.submit("hua"); _ = search.finished(request: 7, matches: hua); _ = search.submit("troll")
        expect(search.availability(true) == [] && search.busy, "A passing check changes nothing")
        expect(search.availability(false) == [.cancelSearch, .order(nil), .returnToPosition] && search.phase == .hidden,
               "Search no longer offered: the box goes, the running search is cancelled and the usual order and position return")
        expect(search.finished(request: 8, matches: troll) == [] && search.submit("x") == [], "Hidden again: nothing applies")

        var restored = HomeSearch(restoring: first)
        expect(restored.phase == .showing(first) && restored.offered, "A relaunch shows the kept result")
        expect(restored.availability(true) == [] && restored.phase == .showing(first), "and keeps it while search is offered")
        expect(restored.availability(false) == [.order(nil), .returnToPosition] && restored.phase == .hidden, "or returns to the usual order when it is not")
        expect(HomeSearch(restoring: nil).phase == .hidden, "Nothing kept: hidden until the check")
        print("PASS: search state machine (hidden, ready, searching, showing; stale requests, cancel, empty box, availability, relaunch)")
    }

    static func order() {
        let catalog = ["a", "b", "c", "d", "e"]
        expect(SearchOrder.apply(catalog, nil, id: { $0 }) == catalog, "No search: the usual order")
        expect(SearchOrder.apply(catalog, SearchResult(query: "q", matches: []), id: { $0 }) == catalog, "No matches: the usual order")
        let result = SearchResult(query: "q", matches: [.init(id: "d", confidence: 90), .init(id: "gone", confidence: 80),
                                                        .init(id: "b", confidence: 40), .init(id: "d", confidence: 10)])
        expect(SearchOrder.apply(catalog, result, id: { $0 }) == ["d", "b", "a", "c", "e"],
               "Matches first, best first; missing and repeated matches skipped; the rest in their usual order")
        expect(SearchOrder.apply(catalog + ["new"], result, id: { $0 }) == ["d", "b", "a", "c", "e", "new"], "A series new since the search keeps its usual place")
        print("PASS: search order (matches first, the rest in their usual order)")
    }
}
