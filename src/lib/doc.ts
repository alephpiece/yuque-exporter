import path from 'path';

import type { Link, Text } from 'mdast';
import { remark } from 'remark';
import { selectAll } from 'unist-util-select';
import { visit, SKIP, CONTINUE} from 'unist-util-visit';
import {gfmTable} from 'micromark-extension-gfm-table'
import {gfmTableFromMarkdown, gfmTableToMarkdown} from 'mdast-util-gfm-table'
import {fromMarkdown} from 'mdast-util-from-markdown'
import {toMarkdown} from 'mdast-util-to-markdown'
import decodeUriComponent from 'decode-uri-component';
import yaml from 'yaml';

import { TreeNode } from './types.js';
import { readJSON, download, getRedirectLink } from './utils.js';
import { config } from '../config.js';

const { host, metaDir, outputDir, userAgent } = config;

interface Options {
  doc: TreeNode;
  mapping: Record<string, TreeNode>;
}

export async function buildDoc(doc: TreeNode, mapping: Record<string, TreeNode>) {
  const docDetail = await readJSON(path.join(metaDir, doc.namespace, 'docs', `${doc.url}.json`));

  // remark 处理链接，后续用 mdast-util 处理 HTML 和表格。
  const content = await remark()
    .data('settings', { bullet: '-', listItemIndent: 'one' })
    .use([
      [ relativeLink, { doc, mapping }],
      [ transformImages, { doc, mapping }],
    ])
    .process(docDetail.body);
  
  doc.content = frontmatter(doc) +
    transformWithRegex(
      transformWithMdast(content.toString()
      )
    );

  // FIXME: remark will transform `*` to `\*`
  doc.content = doc.content.replaceAll('\\*', '*');

  return doc;
}

function transformWithMdast(mdstring) {
  const tree = fromMarkdown(mdstring, {
    extensions: [gfmTable],
    mdastExtensions: [gfmTableFromMarkdown]
  });

  // debugging
  console.log(JSON.stringify(tree, null, 2));

  // 遍历整个 mdast，分别处理各种 nodes。
  visit(tree, visitor);

  function visitor(node, parent) {
    switch (node.type) {
      case 'table':
        // 不要进入 table。
        return SKIP;
      case 'html':
        // 清理不必要的 HTML 标记。
        if (node.value === '<br />' ||
          node.value === '<br/>') {
          node.type = 'text';
          node.value = '\n';
        } else if (node.value.includes('<a name=') ||
          node.value === '</a>') {
          node.type = 'text';
          node.value = '';
        }
        break;
      case 'text':
        // 给 strongs 加上 zero-width spaces。
        if (parent && parent.type === 'strong')
          node.value = node.value + '\u200B';
        break;
      default:
        break;
    }
    return CONTINUE;
  };

  return toMarkdown(tree, {extensions: [gfmTableToMarkdown()]});
}

function frontmatter(doc) {
  const frontMatter = yaml.stringify({
    //title: doc.title,
    url: `${host}/${doc.namespace}/${doc.url}`,
    // slug: doc.slug,
    // public: doc.public,
    // status: doc.status,
    // description: doc.description,
  });
  return `---\n${frontMatter}---\n\n`;
}

function relativeLink({ doc, mapping }: Options) {
  return async tree => {
    const links = selectAll('link', tree) as Link[];
    for (const node of links) {
      if (!isYuqueDocLink(node.url)) continue;

      // 语雀分享链接功能已下线，替换为 302 后的地址
      if (node.url.startsWith(`${host}/docs/share/`)) {
        node.url = await getRedirectLink(node.url, host);
      }

      // 语雀链接有多种显示方式，其中一种会插入该参数，会导致点击后的页面缺少头部导航
      node.url = node.url.replace('view=doc_embed', '');

      const { pathname } = new URL(node.url);
      const targetNode = mapping[pathname.substring(1)];
      if (!targetNode) {
        console.warn(`[WARN] ${node.url}, ${pathname.substring(1)} not found`);
      } else {
        node.url = path.relative(path.dirname(doc.filePath), targetNode.filePath) + '.md';
      }
    }
  };
}

function isYuqueDocLink(url?: string) {
  if (!url) return false;
  if (!url.startsWith(host)) return false;
  if (url.startsWith(host + '/attachments/')) return false;
  return true;
}

function transformImages(opts: Options) {
  return async tree => {
    const docFilePath = opts.doc.filePath;
    const assetsDir = path.join(docFilePath.split('/')[0], 'assets');

    // FIXME: 语雀附件现在不允许直接访问，需要登录后才能下载，这里先跳过。
    // const assetNodes = selectAll(`image[url^=http], link[url^=${host}/attachments/]`, tree) as Link[];
    visit(tree, function (node, index, parent) {
      if (
        parent &&
        typeof index === 'number' &&
        node.type === 'image' &&
        node.url.includes('https:')
      ) {
        const urlObject = new URL(node.url);
        const reCode = /^#card=math&code=(?<code>.*?)&/g;
        if (urlObject.pathname.includes('__latex')) {
          const match = reCode.exec(urlObject.hash);
          node.alt = 'MATH';
          node.url = match.groups.code;
        } else {
          const assetName = `${opts.doc.url}/${urlObject.pathname.split('/').pop()}`;
          const filePath = path.join(assetsDir, assetName);
          download(node.url, path.join(outputDir, filePath), { headers: { 'User-Agent': userAgent } });
          //node.url = path.relative(path.dirname(docFilePath), filePath);
          node.alt = 'IMAGE';
          node.url = assetName;
          node.title = '';
        }
      }
    });
  };
}

function transformWithRegex(mdstring) {
  const reImage = /\!\[IMAGE\]\((.*?)\)/g;
  const reMath = /(\n\>? ?)\!\[MATH\]\(([^\!]*?)\)([,，]?)\n/g;
  const reInlineMath = / ?\!\[MATH\]\((.*?)\) ?/g;
  return mdstring
  .replaceAll(
    // 替换所有公式链接为公式本身。
    reMath,
    (match, p1, p2, p3, offset, string) => {
      const mathExp = decodeUriComponent(p2);
      return `${p1}$$\n${mathExp}${p3 ? ',' : ''}\n$$\n`;
    }
  ).replaceAll(
    // 替换所有公式链接为公式本身。
    reInlineMath,
    (match, p1, offset, string) => {
      const mathExp = decodeUriComponent(p1).replaceAll('\n', '');
      return ` $${mathExp}$ `;
    }
  ).replaceAll(
    // 替换所有图片链接为 Obsidian 格式。
    reImage,
    '![[$1]]'
  ).replaceAll(
    // 替换所有标题前的多换行为单换行。
    /\n+?\#/g,
    '\n\n#'
  ).replaceAll(
    // 替换所有高亮块。
    /\:\:\:([a-z])/g,
    '\`\`\`ad-$1'
  ).replaceAll(
    /\:\:\:/g,
    '\`\`\`'
  ).replaceAll(
    // 给没加 zero-width space 的 strongs 加上。
    /）[\\]?\*[\\]?\*/g,
    '）\u200B**'
  ).replaceAll(
    // 替换奇怪的 checkbox 转义。
    /[\-\*] +\\\[/g,
    '- ['
  ).replaceAll(
    // 把'&#x20'全换成空格。
    /\&\#x20;/g,
    ' '
  );
}
