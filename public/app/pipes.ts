import { Pipe, PipeTransform } from '@angular/core';
import { Location } from '@angular/common';

@Pipe({name: 'autoProxy'})
export class AutoProxyPipe implements PipeTransform {
  transform(url: string): string {
    if (!url || location.protocol != 'https:') return url;
    return '/proxy?url=' + encodeURIComponent(url);
  }
}
