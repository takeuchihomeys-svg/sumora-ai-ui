const XLSX = require('xlsx');

const files = [
  ['sumora', 'public/templates/sumora-estimate.xls'],
  ['ieyasu', 'public/templates/ieyasu-estimate.xls'],
  ['giga',   'public/templates/giga-estimate.xls'],
];

for (const [name, fp] of files) {
  console.log('===== ' + name.toUpperCase() + ' =====');
  const wb = XLSX.readFile(fp);
  console.log('Sheets:', wb.SheetNames);
  const sheetName = wb.SheetNames.length > 1 ? wb.SheetNames[1] : wb.SheetNames[0];
  console.log('Using sheet:', sheetName);
  const ws = wb.Sheets[sheetName];
  for (let r = 0; r < 42; r++) {
    for (let c = 0; c <= 17; c++) {
      const addr = XLSX.utils.encode_cell({r, c});
      const cell = ws[addr];
      if (cell && cell.v !== undefined && cell.v !== null && cell.v !== '') {
        const col = String.fromCharCode(65 + c);
        const finfo = cell.f ? ' (f=' + cell.f + ')' : '';
        console.log('  ' + col + (r+1) + ': [' + cell.t + '] ' + JSON.stringify(cell.v) + finfo);
      }
    }
  }
  console.log('');
}
