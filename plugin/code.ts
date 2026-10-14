type ApplyMessage = {
  type: "apply";
  headline: string;
  imageBytes: Uint8Array | null;
};

type ApplyJobMessage = {
  type: "apply-job";
  jobId: string;
  headline: string;
  imageBytes: Uint8Array | null;
};

type CloseMessage = {
  type: "close";
};

type FrameResult = {
  frameName: string;
  headlineOk: boolean;
  imageOk: boolean;
  error?: string;
};

type RenderExport = {
  name: string;
  bytes: Uint8Array;
};

const HEADLINE_SLOT = "slot:headline";
const HERO_IMAGE_SLOT = "slot:hero_image";

function findByName(root: SceneNode, name: string): SceneNode | null {
  if (root.name === name) return root;

  if ("children" in root) {
    for (const child of root.children) {
      const found = findByName(child, name);
      if (found) return found;
    }
  }

  return null;
}

function getTopFrames(): FrameNode[] {
  return figma.currentPage.children.filter(
    (node): node is FrameNode => node.type === "FRAME",
  );
}

async function setHeadlineText(node: TextNode, newText: string): Promise<void> {
  const segments = node.getStyledTextSegments(["fontName"]);
  const fonts = new Map<string, FontName>();

  for (const segment of segments) {
    fonts.set(
      `${segment.fontName.family}::${segment.fontName.style}`,
      segment.fontName,
    );
  }

  if (fonts.size === 0) {
    fonts.set("default", node.fontName as FontName);
  }

  await Promise.all(
    [...fonts.values()].map((font) => figma.loadFontAsync(font)),
  );

  const fallbackFont = segments[0]?.fontName ?? [...fonts.values()][0]!;
  node.characters = newText;
  node.setRangeFontName(0, newText.length, fallbackFont);
}

async function setHeroImage(
  node: SceneNode,
  imageBytes: Uint8Array,
): Promise<void> {
  if (!("fills" in node)) {
    throw new Error(`"${node.name}" (${node.type}) não tem fills.`);
  }

  const currentFills = node.fills;

  if (currentFills === figma.mixed) {
    throw new Error(
      `"${node.name}" tem fills mistos, não é possível trocar a imagem.`,
    );
  }

  const fills = (currentFills as Paint[]).map((fill) => ({ ...fill }));
  const imageIndex = fills.findIndex((fill) => fill.type === "IMAGE");

  if (imageIndex === -1) {
    throw new Error(`Nenhum fill do tipo IMAGE encontrado em "${node.name}".`);
  }

  const image = figma.createImage(imageBytes);
  const imagePaint = fills[imageIndex] as ImagePaint;

  // O imageTransform antigo foi calibrado pra proporção da imagem anterior;
  // reaproveitá-lo com uma imagem de proporção diferente distorce o
  // resultado. Reseta pra uma cobertura centralizada padrão a cada troca
  // (o usuário pode reajustar o crop manualmente depois, se quiser).
  const identityTransform: Transform = [
    [1, 0, 0],
    [0, 1, 0],
  ];

  fills[imageIndex] =
    imagePaint.scaleMode === "CROP"
      ? {
          ...imagePaint,
          imageHash: image.hash,
          imageTransform: identityTransform,
        }
      : { ...imagePaint, imageHash: image.hash };

  node.fills = fills;
}

async function applyToFrame(
  frame: FrameNode,
  headline: string,
  imageBytes: Uint8Array | null,
): Promise<FrameResult> {
  const result: FrameResult = {
    frameName: frame.name,
    headlineOk: false,
    imageOk: false,
  };

  const errors: string[] = [];

  const headlineNode = findByName(frame, HEADLINE_SLOT);
  if (headlineNode && headlineNode.type === "TEXT") {
    try {
      await setHeadlineText(headlineNode, headline);
      result.headlineOk = true;
    } catch (error) {
      errors.push(`headline: ${(error as Error).message}`);
    }
  } else {
    errors.push(`"${HEADLINE_SLOT}" não encontrado`);
  }

  if (imageBytes) {
    const heroNode = findByName(frame, HERO_IMAGE_SLOT);
    if (heroNode) {
      try {
        await setHeroImage(heroNode, imageBytes);
        result.imageOk = true;
      } catch (error) {
        errors.push(`imagem: ${(error as Error).message}`);
      }
    } else {
      errors.push(`"${HERO_IMAGE_SLOT}" não encontrado`);
    }
  }

  if (errors.length > 0) {
    result.error = errors.join(" | ");
  }

  return result;
}

async function applyToAllFrames(
  headline: string,
  imageBytes: Uint8Array | null,
): Promise<FrameResult[]> {
  const frames = getTopFrames();

  if (frames.length === 0) {
    return [
      {
        frameName: "(nenhum frame na página)",
        headlineOk: false,
        imageOk: false,
        error: "sem frames",
      },
    ];
  }

  const perFrame: FrameResult[] = [];
  for (const frame of frames) {
    perFrame.push(await applyToFrame(frame, headline, imageBytes));
  }
  return perFrame;
}

async function handleApply(
  headline: string,
  imageBytes: Uint8Array | null,
): Promise<void> {
  const perFrame = await applyToAllFrames(headline, imageBytes);
  const ok = perFrame.every((result) => !result.error);

  figma.ui.postMessage({ type: "apply-result", ok, perFrame });
  figma.notify(
    ok ? "Aplicado nas peças! 🎉" : "Aplicado com avisos — veja o painel.",
  );
}

async function exportFrames(frames: FrameNode[]): Promise<RenderExport[]> {
  const renders: RenderExport[] = [];

  for (const frame of frames) {
    try {
      const bytes = await frame.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 2 },
      });
      renders.push({ name: frame.name, bytes });
    } catch (error) {
      // Uma falha ao exportar não deve travar as outras peças — só essa
      // fica sem imagem pra baixar depois.
      console.log(
        `Falha ao exportar "${frame.name}": ${(error as Error).message}`,
      );
    }
  }

  return renders;
}

async function handleApplyJob(
  jobId: string,
  headline: string,
  imageBytes: Uint8Array | null,
): Promise<void> {
  const frames = getTopFrames();
  const perFrame: FrameResult[] = [];
  for (const frame of frames) {
    perFrame.push(await applyToFrame(frame, headline, imageBytes));
  }

  const ok = perFrame.every((result) => !result.error);
  const error = ok
    ? undefined
    : perFrame
        .map((r) => r.error)
        .filter(Boolean)
        .join(" | ");
  const renders = await exportFrames(frames);

  figma.ui.postMessage({ type: "apply-job-result", jobId, ok, error, renders });
  figma.notify(ok ? `Projeto aplicado! 🎉` : `Projeto com erro — veja o log.`);
}

figma.showUI(__html__, { width: 360, height: 480 });

figma.ui.onmessage = async (
  msg: ApplyMessage | ApplyJobMessage | CloseMessage,
) => {
  if (msg.type === "apply") {
    await handleApply(msg.headline, msg.imageBytes);
  } else if (msg.type === "apply-job") {
    await handleApplyJob(msg.jobId, msg.headline, msg.imageBytes);
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};
