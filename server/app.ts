import 'dotenv/config'
import express from 'express'
import puzzle from "../src/services/crypto/puzzle";
import { Instance } from "../src/services/util/instance";
import { assemble } from "clvm_tools/clvm_tools/binutils";
import { parseBlock, parseCoin, sexpAssemble, simplifyPuzzle } from "../src/services/coin/analyzer";

const app: express.Express = express()
app.use(express.json({ limit: '3mb' }))
app.use(express.urlencoded({ extended: true }))

interface ParseBlockRequest {
  ref_list?: string[],
  generator: string,
}

interface ParsePuzzleRequest {
  puzzle: string,
}

Instance.init().then(() => {
  app.post('/parse_block', async (req: express.Request, res: express.Response) => {
    try {
      console.time("parse_block");
      const r = req.body as ParseBlockRequest;
      const bg = await parseBlock(r.generator, r.ref_list);
      const prog = sexpAssemble(bg);
      const argarr = await Promise.all(Array.from(prog.first().as_iter())
        .map(async _ => await parseCoin(_)));

      console.log(`generated ${argarr.length} coins`);
      // res.send(JSON.stringify(argarr, null, 4))
      res.send(JSON.stringify(argarr))
    }
    catch (err) {
      console.warn(err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.status(500).send(JSON.stringify({ success: false, error: (<any>err).message }))
    }
    finally {
      console.timeEnd("parse_block");
    }
  })

  app.post('/parse_puzzle', async (req: express.Request, res: express.Response) => {
    try {
      const r = req.body as ParsePuzzleRequest;
      const puz = await puzzle.disassemblePuzzle(r.puzzle);
      const decPuzzle = await simplifyPuzzle(assemble(puz));
      res.send(JSON.stringify(decPuzzle))
    }
    catch (err) {
      console.warn(err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.status(500).send(JSON.stringify({ success: false, error: (<any>err).message }))
    }
  });
});

export default app;