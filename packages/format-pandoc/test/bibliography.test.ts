// Reading bibliographies just far enough to offer and show citations.
import { describe, expect, it } from 'vitest';
import { bibliographyPaths, entryLabel, headerReferences, readBibliography } from '../src/index.js';

const BIB = String.raw`
% A comment with an @ sign: ada@example.org
@string{ jbe = "Journal of Bee Ecology" }

@article{hall2017,
  author  = {Hall, Damon M. and Camilo, Gerardo R. and Tonietto, Rebecca K.},
  title   = {The {City} as a Refuge for Insect Pollinators},
  journal = jbe,
  year    = 2017,
}

@Book{who2020,
  author = {{World Health Organization}},
  title = "Guidelines on {P}hysical Activity",
  date = {2020-11-25},
}

@inproceedings(muller2019,
  author = {M{\"u}ller, J{\"o}rg and Jane van der Berg},
  title = {Two -- Authors},
  year = {2019a}
)

@misc{broken, title = {never closed
`;

describe('bibliographies', () => {
  it('reads BibTeX: key, family names, year and title, tolerating what it cannot read', () => {
    const entries = readBibliography(BIB, 'refs.bib');
    expect(entries.map((e) => e.key)).toEqual(['hall2017', 'who2020', 'muller2019']);
    expect(entries[0]).toEqual({ key: 'hall2017', authors: ['Hall', 'Camilo', 'Tonietto'], year: '2017', title: 'The City as a Refuge for Insect Pollinators' });
    expect(entries[1]!.authors).toEqual(['World Health Organization']);
    expect(entries[1]!.year).toBe('2020');
    expect(entries[2]!.authors).toEqual(['Müller', 'van der Berg']);
    expect(entries[2]!.title).toBe('Two – Authors');
    expect(entryLabel(entries[0]!)).toBe('Hall et al. 2017');
    expect(entryLabel(entries[2]!)).toBe('Müller & van der Berg 2019a');
  });

  it('reads CSL JSON and CSL YAML', () => {
    const json = JSON.stringify([{ id: 'doe2001', author: [{ family: 'Doe', given: 'Jo' }], issued: { 'date-parts': [[2001, 4]] }, title: 'A Study' }]);
    expect(readBibliography(json, 'refs.json')).toEqual([{ key: 'doe2001', authors: ['Doe'], year: '2001', title: 'A Study' }]);
    const yaml = 'references:\n- id: roe\n  author:\n  - literal: The Roe Group\n  issued: 1999\n  title: Notes\n';
    expect(readBibliography(yaml, 'refs.yaml')).toEqual([{ key: 'roe', authors: ['The Roe Group'], year: '1999', title: 'Notes' }]);
    expect(readBibliography('not json', 'x.json')).toEqual([]);
  });

  it('finds the files and references a header names', () => {
    expect(bibliographyPaths({ bibliography: 'refs.bib' })).toEqual(['refs.bib']);
    expect(bibliographyPaths({ bibliography: ['a.bib', 'b.json', 3] })).toEqual(['a.bib', 'b.json']);
    expect(bibliographyPaths({ title: 'x' })).toEqual([]);
    expect(headerReferences({ references: [{ id: 'x', title: 'T' }] })).toEqual([{ key: 'x', authors: [], year: '', title: 'T' }]);
  });
});
