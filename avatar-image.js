var http = require('http');
var cheerio = require('cheerio');
var debug = require('debug')('bongtalk:AvatarImage');

var AvatarImage = (function(){
  function AvatarImage() {
    this.cachedRandomImageUrls = [];
    this.cacheAvatarImages();
  }

  AvatarImage.prototype.getRandomAvatarUrl = function (callback){
    var self = this;
    var url = self.cachedRandomImageUrls.shift();
    if (url){
      callback(null, url);
      if (!self.cachingRandomImages && self.cachedRandomImageUrls.length < 10) {
        self.cachingRandomImages = true;
        self.cacheAvatarImages(function () {self.cachingRandomImages = false;});
      }
    }
    else {
      self.cacheAvatarImages(function (err, result){
        if (err){
          callback(err, null);
        }
        else {
          callback(null, self.cachedRandomImageUrls.shift());
        }
      });
    }
  };

  AvatarImage.prototype.cacheAvatarImages = function (callback) {
    var self = this;
    self.getRandomAvatarUrls(function (err, result){
      if (!err && result && result.length){
        for (var i = 0; i < result.length; ++i){
          self.cachedRandomImageUrls.push(result[i]);
        }
      }
      if (callback) callback(err, result);
    });
  };

  AvatarImage.prototype.getRandomAvatarUrls = function (callback){
    debug('Get avatars from Avatar Abyss start.');
    http.get('http://avatars.alphacoders.com/avatars/random', function (res){
      // Continuously update stream with data
      var body = '';
      res.on('data', function(d) { body += d; });
      res.on('end', function() {
        var urls = [];
        $ = cheerio.load(body);
        $('img.thumb.img-responsive')
        .map(function (index, img) {
          if (img && img.attribs && img.attribs.src){
            return img.attribs.src;
          }
          return null;
        })
        .filter(function (index, url){ return url; })
        .each(function (index, url){ urls.push(url); });

        if (urls && urls.length){
          debug('Got '+ urls.length +' avatar urls.');
          callback(null, urls);
        }
        else {
          debug('Can not find urls.');
          callback('Can not find urls.', null);
        }
      });
    }).on('error', function (err){
      debug(err);
      callback(err, null);
    });
  };

  return AvatarImage;
})();

module.exports = AvatarImage;
