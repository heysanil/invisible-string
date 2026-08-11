import { describe, expect, test } from "bun:test";

import { findDivClose, inlineResolvedSuspense } from "../lib/suspense-inline";

describe("inlineResolvedSuspense", () => {
  test("returns plain HTML with no Suspense boundary unchanged", () => {
    const html = "<div>hello</div><p>world</p>";
    expect(inlineResolvedSuspense(html)).toBe(html);
  });

  test("inlines a single resolved boundary as <!--$-->…<!--/$-->, not bare content", () => {
    const html =
      "<div>before</div>" +
      '<!--$?--><template id="B:0"></template><p>Loading</p><!--/$-->' +
      "<div>after</div>" +
      '<script>$RB=[];$RC=function(a,b){};$RC("B:0","S:0")</script>' +
      '<div hidden id="S:0"><span>real content</span></div>';

    expect(inlineResolvedSuspense(html)).toBe(
      "<div>before</div><!--$--><span>real content</span><!--/$--><div>after</div>",
    );
  });

  test("resolves sibling boundaries independently, preserving the content between them", () => {
    const html =
      '<!--$?--><template id="B:0"></template><!--/$-->' +
      "<span>middle</span>" +
      '<!--$?--><template id="B:1"></template><p>Loading</p><!--/$-->' +
      '<script>$RC("B:0","S:0")</script>' +
      '<div hidden id="S:0">first</div>' +
      '<script>$RC("B:1","S:1")</script>' +
      '<div hidden id="S:1">second</div>';

    expect(inlineResolvedSuspense(html)).toBe(
      "<!--$-->first<!--/$--><span>middle</span><!--$-->second<!--/$-->",
    );
  });

  test("resolves a boundary nested inside another boundary's own resolved segment", () => {
    // Mirrors the real shape: the route boundary's segment (S:0) itself
    // contains the doc body's own unresolved placeholder (B:1) — proving a
    // single global replace can't handle this (see the function's doc
    // comment) is exactly what motivated resolving one boundary at a time.
    const html =
      "START" +
      '<!--$?--><template id="B:0"></template><!--/$-->' +
      "MIDDLE" +
      '<script>$RB=[];$RC=function(a,b){};$RC("B:0","S:0")</script>' +
      '<div hidden id="S:0"><article><!--$?--><template id="B:1"></template><p>Loading</p><!--/$--></article></div>' +
      "GAP" +
      '<script>$RC("B:1","S:1")</script>' +
      '<div hidden id="S:1">BODY</div>' +
      "END";

    const result = inlineResolvedSuspense(html);

    expect(result).not.toContain("<!--$?-->");
    expect(result).not.toContain("div hidden");
    expect(result).not.toContain("$RC(");
    expect(result).toContain("<article><!--$-->BODY<!--/$--></article>");
    expect(result).toBe("START<!--$--><article><!--$-->BODY<!--/$--></article><!--/$-->MIDDLEGAPEND");
  });

  test("strips the Fizz runtime swap-script boilerplate but leaves an unrelated script alone", () => {
    const html =
      '<!--$?--><template id="B:0"></template><!--/$-->' +
      '<script>console.log("keep me")</script>' +
      '<script>$RB=[];$RC=function(a,b){};$RC("B:0","S:0")</script>' +
      '<div hidden id="S:0">content</div>';

    const result = inlineResolvedSuspense(html);
    expect(result).toContain('<script>console.log("keep me")</script>');
    expect(result).not.toContain("$RB");
    expect(result).not.toContain("$RC(");
  });

  test("throws when a boundary has no matching resolved segment", () => {
    const html = '<!--$?--><template id="B:0"></template><!--/$-->no S:0 anywhere';
    expect(() => inlineResolvedSuspense(html)).toThrow(/no resolved segment for boundary B:0/);
  });

  test("throws on an unterminated hidden segment", () => {
    const html =
      '<!--$?--><template id="B:0"></template><!--/$-->' +
      '<div hidden id="S:0">content never closes';
    // Asserted by message, not a bare `.toThrow()`: three different failures
    // upstream of findDivClose (no placeholder number, an unterminated comment
    // boundary, a missing S:0 segment) also throw here, so a bare check would
    // pass while this case silently stopped exercising findDivClose at all.
    expect(() => inlineResolvedSuspense(html)).toThrow(/findDivClose: unterminated <div>/);
  });

  test("throws on a surviving errored-boundary marker (<!--$!-->) that never matched the resolvable placeholder shape", () => {
    // React's errored-boundary form doesn't carry a `<template id="B:N">` at
    // all (it's `<!--$!--><template data-msg="...">…`), so the main loop
    // never touches it — this is the safety-net check catching it instead.
    const html = '<div>ok</div><!--$!--><template data-msg="boom"></template><p>Fallback</p><!--/$-->';
    expect(() => inlineResolvedSuspense(html)).toThrow(/unresolved or errored Suspense boundary/);
  });

  test("throws on a surviving unresolved placeholder marker with no template at all", () => {
    const html = "<div>ok</div><!--$?-->stray marker<!--/$-->";
    expect(() => inlineResolvedSuspense(html)).toThrow(/unresolved or errored Suspense boundary/);
  });
});

describe("findDivClose", () => {
  test("finds the matching close of a div with no nested divs", () => {
    const html = '<div id="x">plain text</div>tail';
    const contentStart = html.indexOf(">") + 1;
    const afterClose = findDivClose(html, contentStart);
    expect(html.slice(afterClose)).toBe("tail");
  });

  test("matches nested divs by depth, not the first </div>", () => {
    const html = "<div>outer<div>inner</div>more outer</div>tail";
    const contentStart = "<div>".length;
    const afterClose = findDivClose(html, contentStart);
    expect(html.slice(contentStart, afterClose - "</div>".length)).toBe("outer<div>inner</div>more outer");
    expect(html.slice(afterClose)).toBe("tail");
  });

  test("throws on an unterminated div", () => {
    const html = "<div>never closes";
    expect(() => findDivClose(html, "<div>".length)).toThrow();
  });
});
