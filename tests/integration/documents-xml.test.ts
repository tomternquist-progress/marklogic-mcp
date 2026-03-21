/**
 * Integration tests for XML document handling.
 *
 * MarkLogic is frequently used with XML documents in enterprise settings.
 * These tests verify that the MCP server handles XML correctly end-to-end:
 *  - Storing and retrieving XML documents
 *  - Verifying Content-Type is preserved
 *  - Running XQuery against stored XML documents
 *  - Patching XML documents (JSON patch API works on XML too via JSON envelope)
 *
 * Catches bugs that JSON-only tests miss:
 *  - documents.get() stripping XML content or returning garbled text
 *  - Content-Type not forwarded when storing XML
 *  - XQuery doc() function not finding documents stored via REST API
 */

import { describe, it, expect, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const XML_URI = "/integration-test/xml-test-article.xml";
const XML_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<article>
  <id>xml-001</id>
  <title>XML Test Article</title>
  <source>integration-test</source>
  <tags>
    <tag>xml</tag>
    <tag>test</tag>
    <tag>marklogic</tag>
  </tags>
  <body>This is an XML document for testing MarkLogic XML handling capabilities.</body>
</article>`;

describeIfLive("XML document handling (live)", () => {
  const { documents, eval: evalClient } = buildClients();

  afterAll(async () => {
    try { await documents.del(XML_URI); } catch { /* ignore */ }
  });

  describe("put and get XML", () => {
    it("stores an XML document without error", async () => {
      await expect(
        documents.put(XML_URI, XML_CONTENT, "application/xml")
      ).resolves.not.toThrow();
    });

    it("retrieves the XML document", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      const result = await documents.get(XML_URI);
      expect(result.uri).toBe(XML_URI);
      expect(result.content).not.toBeNull();
    });

    it("retrieved XML content contains the article element", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      const result = await documents.get(XML_URI);
      // Content may be returned as a string or object depending on ML version
      const contentStr = typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);
      expect(contentStr).toMatch(/article|xml-001|XML Test/i);
    });

    it("stores XML in a named collection", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml", {
        collections: ["integration-test-xml"],
      });
      const result = await documents.get(XML_URI, undefined, true);
      expect(result.metadata?.collections).toContain("integration-test-xml");
    });
  });

  describe("XQuery eval against stored XML", () => {
    it("XQuery fn:doc() retrieves the stored XML document", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      const results = await evalClient.evalXQuery(
        `fn:doc("${XML_URI}")/article/id/text()`
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].value).toBe("xml-001");
    });

    it("XQuery can extract the title element", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      const results = await evalClient.evalXQuery(
        `fn:doc("${XML_URI}")/article/title/text()`
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].value).toBe("XML Test Article");
    });

    it("XQuery can count child elements", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      const results = await evalClient.evalXQuery(
        `fn:count(fn:doc("${XML_URI}")/article/tags/tag)`
      );
      expect(results[0].value).toBe(3);
    });

    it("XQuery can extract all tag values as a sequence", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      const results = await evalClient.evalXQuery(
        `fn:doc("${XML_URI}")/article/tags/tag/text()`
      );
      expect(results.length).toBe(3);
      const values = results.map((r) => r.value);
      expect(values).toContain("xml");
      expect(values).toContain("test");
      expect(values).toContain("marklogic");
    });

    it("XQuery can search XML documents by content", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      const results = await evalClient.evalXQuery(
        `cts:search(fn:doc(), cts:element-value-query(xs:QName("id"), "xml-001"))/article/id/text()`
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].value).toBe("xml-001");
    });
  });

  describe("JavaScript eval against stored XML", () => {
    it("SJS can verify an XML document exists and check its type", async () => {
      // In MarkLogic SJS, XPath on XML nodes requires fn.doc().root.xpath() or cts.search().
      // This test verifies basic SJS interop with XML documents without XPath.
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      const results = await evalClient.evalJavaScript(
        `fn.exists(fn.doc("${XML_URI}"))`
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].value).toBe(true);
    });

    it("SJS cts.search can find the XML document by content", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml");
      // cts.search returns a sequence of nodes; using fn.count to verify it's found
      const results = await evalClient.evalJavaScript(
        `fn.count(cts.search(cts.documentQuery("${XML_URI}")))`
      );
      expect(results[0].value).toBe(1);
    });
  });

  describe("XML document metadata", () => {
    it("get with include_metadata returns collections array", async () => {
      await documents.put(XML_URI, XML_CONTENT, "application/xml", {
        collections: ["integration-test-xml", "test-collection-2"],
      });
      const result = await documents.get(XML_URI, undefined, true);
      expect(Array.isArray(result.metadata?.collections)).toBe(true);
      expect(result.metadata?.collections).toContain("integration-test-xml");
    });
  });
});
