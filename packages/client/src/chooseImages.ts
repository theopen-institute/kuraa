// The dialog that adds images (ImagesDialog.vue, 0106), asked for by a format's
// editor module (EditorUi.chooseImages) as ask.ts's questions are: mounted on
// its own over the page, resolving to the images to add as chosen, or null.
import { createApp } from 'vue';
import type { ImageToAdd } from '@kuraa/editor-kit';
import ImagesDialog from './ImagesDialog.vue';

export function chooseImages(images: ImageToAdd[], storage?: () => Promise<number | null>): Promise<ImageToAdd[] | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(ImagesDialog, {
      images,
      storage,
      onDone: (chosen: ImageToAdd[] | null) => {
        app.unmount();
        host.remove();
        resolve(chosen);
      },
    });
    app.mount(host);
  });
}
