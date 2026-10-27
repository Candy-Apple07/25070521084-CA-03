// React wrapper around the same Lucide icon set the plain-DOM screens use.

import { iconMarkup, type IconName } from './icons';

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <span className="icon-slot" dangerouslySetInnerHTML={{ __html: iconMarkup(name, size) }} />;
}
