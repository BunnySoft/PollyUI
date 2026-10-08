import { childPath } from './desktop/files/model.mjs';

// Only the private Node fixture producer writes in place; this is not a backend.
export async function requestPrivateMutation(files, directory, evidence) {
  console.log('FILE_DIALOG_MUTATION_REQUEST: ' + JSON.stringify({ id: 1, path: childPath(directory, 'eight.txt') }));
  const receiptPath = childPath(evidence, 'in-place.json'), end = Date.now() + 8000;
  while (Date.now() < end) {
    let observation;
    try { observation = files.stat(receiptPath, false); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (observation) {
      const receipt = JSON.parse(files.readText(receiptPath, observation.identity).text);
      if (receipt.error || receipt.id !== 1 || receipt.path !== childPath(directory, 'eight.txt'))
        throw new Error('Private in-place fixture failed: ' + JSON.stringify(receipt));
      console.log('FILE_DIALOG_INPLACE_OBSERVATION: ' + JSON.stringify(receipt));
      return receipt;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Private in-place producer receipt did not arrive');
}
