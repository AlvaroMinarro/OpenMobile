import { describe, expect, it } from "bun:test";
import { detectDiffShape, xmlToTree, uiElementToJson } from "../src/device/serialize";

describe("detectDiffShape", () => {
  it("classifies a CLI diff object by added/modified keys", () => {
    expect(detectDiffShape({ added: [], modified: [] })).toBe("diff");
  });

  it("classifies a full UIElement tree by its convex-ability keys", () => {
    expect(
      detectDiffShape({
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        center: { x: 5, y: 5 },
        interactions: [],
        state: "default",
        offScreen: false,
      }),
    ).toBe("full");
  });

  it("returns unknown for null and primitives", () => {
    expect(detectDiffShape(null)).toBe("unknown");
    expect(detectDiffShape("layout")).toBe("unknown");
    expect(detectDiffShape(42)).toBe("unknown");
  });
});

describe("xmlToTree — uiautomator XML fallback parser", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<hierarchy rotation="0">
  <node index="0" text="Login" resource-id="com.app:id/login" class="android.widget.Button" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][200,80]" displayed="true"/>
  <node index="1" text="" class="android.widget.FrameLayout" clickable="false" focused="false" selected="false" bounds="[0,80][1080,2400]" displayed="true">
    <node index="0" text="hello world" resource-id="com.app:id/body" class="android.widget.TextView" clickable="false" focused="false" scrollable="false" selected="false" bounds="[20,100][520,200]" displayed="true"/>
    <node index="1" text="hidden" bounds="[0,0][300,50]" clickable="false" displayed="false"/>
  </node>
</hierarchy>`;

  it("parses a top-level tappable node into bounds, center and interactions", () => {
    const tree = xmlToTree(xml);
    expect(tree).toHaveLength(2);
    const login = tree[0]!;
    expect(login.interactions).toContain("click");
    expect(login.bounds).toEqual({ left: 0, top: 0, right: 200, bottom: 80 });
    expect(login.center).toEqual({ x: 100, y: 40 });
    expect(login.offScreen).toBe(false);
  });

  it("nests child nodes under their parent", () => {
    const tree = xmlToTree(xml);
    const frame = tree[1]!;
    expect(frame.children).toHaveLength(2);
    expect(frame.children![0]!.text).toBe("hello world");
    expect(frame.children![0]!.center).toEqual({ x: 270, y: 150 });
  });

  it("flags off-screen nodes (displayed=false)", () => {
    const tree = xmlToTree(xml);
    const hidden = tree[1]!.children![1]!;
    expect(hidden.offScreen).toBe(true);
  });
});

describe("uiElementToJson", () => {
  it("serializes an element into a JSON-safe shape", () => {
    const json = uiElementToJson({
      bounds: { left: 0, top: 0, right: 200, bottom: 80 },
      center: { x: 100, y: 40 },
      interactions: ["click"],
      state: "focused",
      offScreen: false,
      text: "Login",
      children: [],
    });
    expect(json).toEqual({
      bounds: { left: 0, top: 0, right: 200, bottom: 80 },
      center: { x: 100, y: 40 },
      interactions: ["click"],
      state: "focused",
      offScreen: false,
      text: "Login",
      children: [],
    });
  });
});
